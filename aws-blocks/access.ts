/**
 * Authentication and authorization for every API method.
 *
 * Effective permissions are not materialized. Each request walks the three
 * hops — user → user groups → role groups — and builds an in-memory map of the
 * spaces it may touch. `requireAccess()` does that once per request; every
 * method starts from it.
 *
 * Listing endpoints must pass their results through `filterReadable()` before
 * returning. That includes search hits and anything the AI assistant or the MCP
 * server produces: there is no second filter downstream.
 */
import { ApiError, isBlocksError, type BlocksContext } from '@aws-blocks/core';
import { DistributedTableErrors } from '@aws-blocks/blocks';

import { auth, table } from './resources.js';
import { readEpoch } from './epoch.js';
import { canonicalUserId, oidcAuth } from './federation.js';
import {
  ALL_SPACES,
  ALL_USERS,
  CONFIG_DEFAULTS,
  CONFIG_PK,
  META,
  PROFILE,
  type Item,
  type Permission,
  atLeast,
  idOf,
  sortable,
  spacePk,
  strongest,
  userGroupPk,
  userPk,
  roleGroupPk,
} from './model.js';

export type SignedInUser = {
  /**
   * Whose permissions apply.
   *
   * The pool's `sub`, whichever door the account came through: a password
   * sign-in reads it from the Cognito session, and a federated sign-in's
   * `${iss}:${sub}` is folded back to the same `sub` at the door
   * (`canonicalUserId`), because a federated account is a pool account too.
   * Opaque everywhere below this line: just the string after `USER#`.
   */
  userSub: string;
  /**
   * Display value. Mutable during employment, never an identifier.
   *
   * Read from the session's ID token, so it can lag a mid-session attribute
   * change until the token refreshes. Nothing gates on it: permission records
   * point at the `sub`, and no API decides anything from an address (the one
   * that did was removed).
   */
  email: string;
  /**
   * Which external IdP signed this account in, absent for a Cognito account.
   *
   * Carried so the management screens can tell the two apart. It is never an
   * input to a permission decision — those read the edges in DynamoDB.
   */
  identityProvider?: string;
};

export type Access = {
  user: SignedInUser;
  /** True when the user reaches a role group carrying `global: true`. */
  isGlobalAdmin: boolean;
  /** Space id → strongest permission reached. Empty for a user with no groups. */
  spaces: Map<string, Permission>;
};

export function forbidden(message: string): never {
  throw new ApiError(message, 403, { name: 'ForbiddenException' });
}

export function notFound(message: string): never {
  throw new ApiError(message, 404, { name: 'ItemNotFoundException' });
}

export function invalid(message: string): never {
  throw new ApiError(message, 400, { name: 'ValidationFailedException' });
}

/** An optimistic-lock collision: the caller read a version someone else replaced. */
export function conflict(message: string): never {
  throw new ApiError(message, 409, { name: 'ConflictException' });
}

/**
 * The structured error name for a delete refused because the page still has
 * children. A distinct name (not the generic `ConflictException`) lets a client
 * — UI, AI assistant, or MCP — branch on the structured identity instead of
 * matching the human-facing message text, which is free to change or localise.
 * `ApiError` serialises `name` to the client, so `error.name` carries it across
 * the wire (see `@aws-blocks/core`'s `isBlocksError`).
 */
export const PAGE_HAS_CHILDREN = 'PageHasChildrenException';

/**
 * A delete refused because the page still has children.
 *
 * `childCount` is for the callers that share this process and have to reword
 * the refusal — the AI assistant and the MCP server, via `leafOnlyDeleteRefusal`
 * in `refusals.ts`. It does not cross the wire: `@aws-blocks/core` serialises
 * only `message`, `status`, `name` and `retriable`, so a browser still reads
 * the count out of the message text.
 */
export class PageHasChildrenError extends ApiError {
  readonly childCount: number;

  constructor(childCount: number) {
    super(
      `This page has ${childCount} child page(s); pass 'cascade' or 'reparent' to say what to do with them`,
      409,
      { name: PAGE_HAS_CHILDREN },
    );
    this.childCount = childCount;
  }
}

/** Refuse a delete because the page still has `count` children. */
export function pageHasChildren(count: number): never {
  throw new PageHasChildrenError(count);
}

// ─── Permission epoch ────────────────────────────────────────────────────────────
// The three hops are skipped when the graph has not changed since the answer was
// computed. "Has not changed" is not assumed from a clock: one record carries the
// generation of the permission graph as a whole, every request reads it, and a
// stored answer is reused only when its generation still matches. So the decision
// stays tied to what DynamoDB holds right now — what is skipped is the recompute,
// not the check.

/** What `walkGroups()` produced, and the generation it was produced under. */
type CachedWalk = {
  epoch: string;
  isGlobalAdmin: boolean;
  spaces: Map<string, Permission>;
  storedAt: number;
};

/**
 * Backstop for an epoch that never moved because `bumpEpoch()` itself failed.
 *
 * Measured on the wall clock, not in requests served: a Lambda execution
 * environment is frozen between invocations and thawed later, and only real time
 * counts the freeze. Counting requests would let an environment that slept ten
 * minutes serve the permissions it resolved before the nap.
 */
const WALK_CACHE_TTL_MS = 300_000;

/**
 * Entry ceiling, and how far an overflow trims back.
 *
 * Overflowing used to drop the whole map, on the reasoning that being wrong
 * costs one extra three-hop resolution. That reasoning holds for one entry and
 * not for all of them: an execution environment that has served more than
 * `MAX_ENTRIES` distinct users would empty its cache each time it crossed the
 * line, so at that size the cache stops paying for itself exactly when the
 * traffic that filled it is heaviest. Trimming to `TRIM_TO` keeps the recent
 * entries and makes an overflow cost a fifth of the map instead of all of it.
 */
const WALK_CACHE_MAX_ENTRIES = 500;
const WALK_CACHE_TRIM_TO = 400;

/** Lives as long as this execution environment does; nothing can reach in. */
const walkCache = new Map<string, CachedWalk>();

/** The stored answer for this user, if it is still of the current generation. */
function cachedWalk(userSub: string, epoch: string | null): CachedWalk | undefined {
  if (epoch === null) return undefined;
  const entry = walkCache.get(userSub);
  if (entry === undefined || entry.epoch !== epoch) return undefined;
  if (Date.now() - entry.storedAt >= WALK_CACHE_TTL_MS) return undefined;
  return entry;
}

/**
 * How long a generation is left to settle before an answer under it is kept.
 *
 * Reading the epoch first (see `storeWalk`) covers a change that lands *after*
 * the read. It cannot cover the other order: `bumpEpoch()` runs after the edge
 * it announces is deleted, but the three hops query without `ConsistentRead` —
 * the block exposes no way to ask for one — so a request that reads the new
 * generation may still be served the deleted GRANT by a replica that has not
 * caught up. That answer would then be labelled *current* and reused for the
 * whole backstop TTL, which is a revoked permission surviving five minutes
 * after the administrator revoked it.
 *
 * So an answer resolved this close to a permission change is used for the
 * request that resolved it and not kept. The stale window shrinks from the TTL
 * to the replication lag itself, which is the part no cache can fix. The cost
 * is three hops per request for ten seconds after every permission change.
 */
const EPOCH_SETTLE_MS = 10_000;

/**
 * Whether a walk resolved now can be trusted to have seen what moved the epoch.
 *
 * The generation is `<ISO timestamp>#<uuid>`, so it carries the moment it was
 * written. An empty generation is the fresh deployment that has never had a
 * permission written at all, which has nothing to be stale about. Anything that
 * does not parse is treated as unsettled: being wrong here costs queries, and
 * the other way costs permissions.
 */
function settled(epoch: string): boolean {
  if (epoch === '') return true;
  const separator = epoch.indexOf('#');
  const written = Date.parse(separator === -1 ? epoch : epoch.slice(0, separator));
  if (Number.isNaN(written)) return false;
  return Date.now() - written >= EPOCH_SETTLE_MS;
}

/**
 * Store an answer under the generation that was read *before* resolving it.
 *
 * The order matters and only works one way. Reading the epoch first means a
 * permission change landing mid-resolution labels a fresh answer with the older
 * generation: the next request sees a mismatch and resolves again, which costs
 * queries and nothing else. Reading it afterwards would do the opposite — label
 * a stale answer with the new generation, and keep serving it.
 */
function storeWalk(userSub: string, epoch: string | null, access: Access): void {
  // Nothing to label the answer with, so it is not kept (see `readEpoch()`).
  if (epoch === null) return;
  // Too soon after the change this generation announces to trust the hops that
  // produced the answer (see `EPOCH_SETTLE_MS`).
  if (!settled(epoch)) return;

  // Re-inserted, not updated in place: a `Map` keeps its keys in insertion
  // order and a `set` on an existing key does not move it, so deleting first is
  // what makes the front of the map the oldest writes — the ones to drop.
  walkCache.delete(userSub);
  if (walkCache.size >= WALK_CACHE_MAX_ENTRIES) {
    for (const oldest of walkCache.keys()) {
      walkCache.delete(oldest);
      if (walkCache.size <= WALK_CACHE_TRIM_TO) break;
    }
  }
  walkCache.set(userSub, {
    epoch,
    isGlobalAdmin: access.isGlobalAdmin,
    spaces: new Map(access.spaces),
    storedAt: Date.now(),
  });
}

/** An `Access` built from a stored answer. The map is copied so callers cannot edit the cache. */
function accessFrom(user: SignedInUser, cached: CachedWalk): Access {
  return { user, isGlobalAdmin: cached.isGlobalAdmin, spaces: new Map(cached.spaces) };
}

/**
 * Resolve who is calling and what they may reach.
 *
 * Hop 1 reads the user's own partition, which holds the profile and every
 * membership, so a single query covers both. Hops 2 and 3 fan out in parallel.
 * A user with no groups gets an empty map rather than an error — that is the
 * state of every account between creation and its first group assignment.
 */
const memo = new WeakMap<object, Promise<Access>>();

export function requireAccess(context: BlocksContext): Promise<Access> {
  // Memoized per request. Pages, search, and the MCP server all call
  // this, and a handler that gates twice must not pay six more queries — nor see
  // two different answers because a permission changed in between.
  const cached = memo.get(context);
  if (cached !== undefined) return cached;
  const resolving = resolveAccess(context);
  memo.set(context, resolving);
  return resolving;
}

/**
 * Which of the two doors this request came through, and as whom.
 *
 * A deployment can have both open: `AuthCognito` for accounts holding a
 * password, `AuthOIDC` for accounts a company's IdP issued. They keep separate
 * sessions and separate cookies, so the only way to know is to ask each.
 *
 * Cognito is asked first because it is the door every deployment has — one
 * without an external IdP never reaches the second question at all. On a
 * federated deployment this costs one session lookup that misses before the one
 * that hits; `requireAccess` memoizes per request, so it is paid once.
 *
 * Both refusals are the same refusal. When neither session exists the Cognito
 * block is asked to raise it, so a signed-out client sees exactly the error it
 * saw before federation existed.
 */
async function whoIsSignedIn(context: BlocksContext): Promise<SignedInUser> {
  const cognitoUser = await auth.getCurrentUser(context);
  if (cognitoUser !== null) {
    return {
      userSub: cognitoUser.userSub,
      email: cognitoUser.attributes.email ?? cognitoUser.username,
    };
  }

  if (oidcAuth !== null) {
    const federated = await oidcAuth.getCurrentUser(context);
    if (federated !== null) {
      return {
        userSub: canonicalUserId(federated.userId),
        email: federated.email ?? federated.username,
        identityProvider: federated.provider,
      };
    }
  }

  const refused = await auth.requireAuth(context);
  // Unreachable: `requireAuth` throws whenever `getCurrentUser` returned null.
  // Kept so the function has one return type rather than a cast.
  return { userSub: refused.userSub, email: refused.username };
}

async function resolveAccess(context: BlocksContext): Promise<Access> {
  const signedIn = await whoIsSignedIn(context);
  const { userSub, email } = signedIn;

  const epoch = await readEpoch();
  const cached = cachedWalk(userSub, epoch);
  // A stored answer stands in for hop 1 as well: an entry only exists because a
  // previous request already found the profile, and no API deletes one. What it
  // does defer is the display-address sync below, by at most the backstop TTL —
  // nothing gates on that address.
  if (cached !== undefined) return accessFrom(signedIn, cached);

  // ── Hop 1: profile + memberships ──
  let own = await Array.fromAsync(table.query({ where: { pk: { equals: userPk(userSub) } } }));
  let profile = own.find((item) => item.type === 'USER');

  let provisioned = false;
  if (profile === undefined) {
    await provisionUser(signedIn);
    provisioned = true;
    own = await Array.fromAsync(table.query({ where: { pk: { equals: userPk(userSub) } } }));
    profile = own.find((item) => item.type === 'USER');
  } else if (profile.email !== email) {
    // The address is the sign-in identity's own and can change during
    // employment. Keep the display copy current; a lost race just means the
    // next request rewrites it.
    await syncEmail(profile, email);
  }

  const access = await walkGroups(signedIn, own);
  // A just-provisioned user is not stored. Provisioning may have written a
  // membership (the default user group) and the re-query above reads
  // it back through an eventually consistent query — if that read misses its own
  // write, the answer is "reaches nothing". Storing it would freeze that answer
  // until the backstop TTL, because provisioning does not move the epoch: the
  // write is the same user's first membership, not a change to anyone else's
  // permissions. Skipping the store costs one extra resolution on the next
  // request and keeps the first sign-in from starting with an empty Wiki.
  if (!provisioned) storeWalk(userSub, epoch, access);
  return access;
}

/**
 * The same three-hop resolution, for a caller identified by their `sub` alone.
 *
 * The AI assistant's tools run inside the Agent block's async job, which has no
 * request context to authenticate: the user is named by the tool context the API
 * layer filled in from the authenticated session. Everything after
 * hop 1 is identical, so a tool is gated by exactly the checks the UI-facing API
 * is gated by.
 *
 * Unlike the request path this never provisions. A directory record is written
 * on the caller's first sign-in, and the assistant can only be reached by
 * someone who has signed in — so a missing profile here is not a new account,
 * it is an identifier that did not come from a session. Refusing is the
 * fail-closed reading.
 */
export async function accessForUser(userSub: string): Promise<Access> {
  if (userSub === '') forbidden('Unknown user');
  const epoch = await readEpoch();
  // Hop 1 runs even on a cache hit here, unlike the request path: there is no
  // session to read the display address from, and the profile is what carries it.
  // Hops 2 and 3 are still what the stored answer saves.
  const own = await Array.fromAsync(table.query({ where: { pk: { equals: userPk(userSub) } } }));
  const profile = own.find((item) => item.type === 'USER');
  if (profile === undefined) forbidden('Unknown user');
  const user: SignedInUser = {
    userSub,
    email: profile.email ?? '',
    identityProvider: profile.identityProvider,
  };

  const cached = cachedWalk(userSub, epoch);
  if (cached !== undefined) return accessFrom(user, cached);

  const access = await walkGroups(user, own);
  storeWalk(userSub, epoch, access);
  return access;
}

/**
 * Hops 2 and 3, shared by both entry points. `own` is the user's partition.
 *
 * Two kinds of edge leave a user. `MEMBERSHIP` names a user group and needs hop
 * 2 to reach the role groups attached to it. `ROLE_MEMBERSHIP` names a role
 * group outright and skips straight to hop 3 — that is the shape an external
 * IdP's groups are written in, because the IdP already *is* the layer that
 * groups people, and repeating it here would mean maintaining the same sets
 * twice.
 *
 * Both feed one set of role group ids, so hop 3 and everything after it cannot
 * tell which kind of edge a permission arrived by.
 */
async function walkGroups(user: SignedInUser, own: Item[]): Promise<Access> {
  const userGroupIds = own
    .filter((item) => item.type === 'MEMBERSHIP')
    .map((item) => idOf(item.sk));
  const directRoleGroupIds = own
    .filter((item) => item.type === 'ROLE_MEMBERSHIP')
    .map((item) => idOf(item.sk));

  // ── Hop 2: user groups → role groups ──
  const attachments = await Promise.all(
    userGroupIds.map((id) =>
      Array.fromAsync(
        table.query({
          where: { pk: { equals: userGroupPk(id) }, sk: { beginsWith: 'RG#' } },
        }),
      ),
    ),
  );
  const roleGroupIds = [
    ...new Set([...directRoleGroupIds, ...attachments.flat().map((item) => idOf(item.sk))]),
  ];

  // ── Hop 3: role groups → grants ──
  const roleGroups = await Promise.all(
    roleGroupIds.map((id) =>
      Array.fromAsync(table.query({ where: { pk: { equals: roleGroupPk(id) } } })),
    ),
  );

  const access: Access = { user, isGlobalAdmin: false, spaces: new Map() };
  for (const items of roleGroups) {
    for (const item of items) {
      if (item.type === 'ROLE_GROUP' && item.global === true) access.isGlobalAdmin = true;
      if (item.type === 'GRANT' && item.permission !== undefined) {
        const spaceId = idOf(item.sk);
        access.spaces.set(spaceId, strongest(access.spaces.get(spaceId), item.permission));
      }
    }
  }
  return access;
}

/**
 * Create the directory record for an account signing in for the first time.
 *
 * Cognito owns the password accounts and AuthCognito exposes no way to
 * enumerate them, so the directory is filled in here rather than at account
 * creation. A federated account normally has its record written a moment
 * earlier, by the sign-in hook in `federation.ts`; this path still covers it,
 * because a session outlives the sign-in that created it and the directory row
 * could have been deleted since.
 */
async function provisionUser(user: SignedInUser): Promise<void> {
  const { userSub, email, identityProvider } = user;
  const now = new Date().toISOString();
  await table.put(
    {
      pk: userPk(userSub),
      sk: PROFILE,
      type: 'USER',
      gsi1pk: ALL_USERS,
      gsi1sk: sortable(email),
      email,
      ...(identityProvider !== undefined ? { identityProvider } : {}),
      createdAt: now,
      version: 0,
    },
    { ifNotExists: true },
  ).catch(swallowConditionalFailure);

  // The default user group is a Wiki-side grant, so it is only handed to
  // Wiki-side accounts. A federated account's permissions come from its IdP's
  // groups and nowhere else; adding one here would be a permission the IdP
  // never granted and the administrator cannot see the origin of. A deployment
  // that wants every federated employee to reach a space maps an IdP group
  // everyone belongs to onto a role group, which says the same thing in the
  // one place that owns the answer.
  if (identityProvider !== undefined) return;

  const defaults = await table.get({ pk: CONFIG_PK, sk: CONFIG_DEFAULTS });
  const defaultUserGroupId = defaults?.defaultUserGroupId;
  if (defaultUserGroupId !== undefined && defaultUserGroupId !== '') {
    await table.put(
      {
        pk: userPk(userSub),
        sk: userGroupPk(defaultUserGroupId),
        type: 'MEMBERSHIP',
        gsi1pk: userGroupPk(defaultUserGroupId),
        gsi1sk: userPk(userSub),
        addedAt: now,
        addedBy: 'system:default-group',
      },
      { ifNotExists: true },
    ).catch(swallowConditionalFailure);
  }
}

async function syncEmail(profile: Item, email: string): Promise<void> {
  await table
    .put(
      { ...profile, email, gsi1sk: sortable(email), version: (profile.version ?? 0) + 1 },
      { ifFieldEquals: { version: profile.version ?? 0 } },
    )
    .catch(swallowConditionalFailure);
}

/** Concurrent writers racing on an idempotent write is the expected outcome. */
export function swallowConditionalFailure(error: unknown): void {
  if (!isConditionalFailure(error)) throw error;
}

/** Matched through the block's constant; the wire name is its implementation detail. */
export function isConditionalFailure(error: unknown): boolean {
  return isBlocksError(error, DistributedTableErrors.ConditionalCheckFailed);
}

// ─── Gates ───────────────────────────────────────────────────────────────────

/** Permission held on one space. Global administrators hold `admin` everywhere. */
export function permissionOn(access: Access, spaceId: string): Permission | undefined {
  return access.isGlobalAdmin ? 'admin' : access.spaces.get(spaceId);
}

/**
 * Gate an operation on one space.
 *
 * `subject` names what the refusal should talk about. It defaults to the space,
 * which is right when the caller named the space themselves. Callers that
 * reached the space from a page id pass `'Page'`: the space id is something
 * they may have no business knowing, and repeating it in a 404 would confirm
 * both that the page exists and where it lives — the leak the "report it as
 * absent" rule exists to prevent.
 */
export function requireSpace(
  access: Access,
  spaceId: string,
  need: Permission,
  subject = `Space ${spaceId}`,
): Permission {
  const held = permissionOn(access, spaceId);
  // A space the caller cannot read is reported as absent: telling them it exists
  // would leak the space list.
  if (held === undefined) notFound(`${subject} not found`);
  if (!atLeast(held, need)) forbidden(`Requires ${need} on ${subject.toLowerCase()}`);
  return held;
}

export function requireGlobalAdmin(access: Access): void {
  if (!access.isGlobalAdmin) forbidden('Requires global administrator');
}

/**
 * The single permission filter for anything that returns many spaces' worth of
 * data — space lists, page lists, search hits, RAG context.
 */
export function filterReadable<T extends { spaceId: string }>(access: Access, items: T[]): T[] {
  if (access.isGlobalAdmin) return items;
  return items.filter((item) => access.spaces.has(item.spaceId));
}

/**
 * Space metadata the caller may read.
 *
 * The reachable space ids are already in memory, so this is a batched key
 * lookup rather than a query — and never a scan.
 */
export async function readableSpaces(access: Access): Promise<Item[]> {
  if (access.isGlobalAdmin) {
    return await Array.fromAsync(
      table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_SPACES } } }),
    );
  }
  // Splitting to BatchGetItem's 100-key limit is the block's job: `getBatch`
  // chunks internally and retries whatever DynamoDB leaves unprocessed.
  const keys = [...access.spaces.keys()].map((spaceId) => ({ pk: spacePk(spaceId), sk: META }));
  const items = await table.getBatch(keys);
  return items.filter((item): item is Item => item !== null);
}

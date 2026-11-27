/**
 * Sign-in through an external identity provider.
 *
 * The Wiki answers to two kinds of account, and both live in the same Cognito
 * user pool. One holds a password in the pool and is served by the `Auth`
 * block `auth` in `resources.ts`. The other is issued by a company's own IdP —
 * OneLogin, Okta, Entra — which `index.cdk.ts` registers on that same pool as
 * an OIDC identity provider. The `Auth` block here (`store: 'builtin'`) does
 * not talk to that IdP: its providers point at the pool's own issuer URL,
 * whose hosted sign-in domain forwards to the IdP and creates the federated
 * account in the pool on the way back. What this block receives is a
 * Cognito-issued ID token, whichever IdP stood behind it.
 *
 * The block is deliberately not given the pool to federate through itself
 * (a default-store block with `type: 'oidc'` providers). That would make it
 * create its own hosted-UI client and domain and its own IdP registrations,
 * and the accounts it created would be named by a different identifier than
 * the ones the permission records already point at.
 *
 * Both kinds land in the same permission model under the same identifier — the
 * pool's `sub`. `access.ts` reads whichever session exists and hands the
 * resolved identifier to the same three-hop walk, so nothing downstream of it
 * knows which door a request came through.
 *
 * ─── Why the Building Block lives here and not in `resources.ts` ─────────────
 * Its `onSignIn` hook is the claim-to-role-group synchronisation below, which
 * needs the permission table. `resources.ts` is what *provides* that table, so
 * configuring the block there would be a cycle. The Agent block in
 * `assistant.ts` sits outside `resources.ts` for the same reason: a block whose
 * configuration is application logic lives with that logic.
 *
 * ─── What decides permissions, and what does not ────────────────────────────
 * The IdP's group claim is never read at authorization time. It is read once,
 * at sign-in, and written into `ROLE_MEMBERSHIP` edges in DynamoDB. Everything
 * that decides what a request may do reads those edges. That keeps the single
 * authorization path this project is built on — a claim cannot become a second
 * way to be permitted.
 */
import { AppSetting, Auth, KVStoreErrors, getDeploymentType, stubIdp } from 'aws-cdk-blocks';
import type { AuthenticatedUser, BuiltinProvider } from 'aws-cdk-blocks';
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';

import { runtimeSsoProviders, ssoSettingIds } from './sso-config.js';
import { DEPLOYED } from './deployed.js';
import { putItem, scope, table, valuesOf } from './resources.js';
import { bumpEpoch } from './epoch.js';
import {
  ALL_ROLE_GROUPS,
  ALL_USERS,
  IDP_SYNC,
  PROFILE,
  type Item,
  idOf,
  roleGroupPk,
  sortable,
  userPk,
} from './model.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * The OIDC issuer the block signs in against — the Wiki's own user pool.
 *
 * Not the external IdP's issuer: the pool sits between, and its discovery
 * document names the hosted sign-in domain that forwards to the IdP. The
 * deploy scripts derive this from the running stack's pool id, so an operator
 * never types it.
 *
 * Deploy-time rather than a stored setting, because the block needs a concrete
 * string when the provider is constructed — which happens during synth, before
 * any stored value could be read. Leaving it unset is how a deployment says it
 * has no external IdP: no provider is declared, no routes are created, and the
 * sign-in screen offers only the password form.
 *
 * Trailing slashes are dropped so the value compares equal to the `iss` claim
 * Cognito writes into its tokens, which `canonicalUserId` below relies on.
 */
const ISSUER_URL = (process.env.SSO_ISSUER_URL ?? '').trim().replace(/\/+$/, '');

/**
 * Which ID-token claim carries the signing-in user's groups.
 *
 * On a deployed stack the token is Cognito's, and the IdP's group claim
 * arrives copied into the pool's `custom:groups` attribute by the identity
 * provider registration in `index.cdk.ts` — the deploy scripts set this to
 * `custom:groups` accordingly. The default stays `groups` for the local stub,
 * which issues its claims directly with no pool in between. It sits in the
 * environment beside the issuer URL because both describe the *shape* of what
 * is being talked to; the credentials are stored settings, and the mapping
 * from groups to permissions is the Wiki's own data. Three kinds of
 * configuration, three places, chosen by who owns the answer.
 */
const GROUPS_CLAIM = (process.env.SSO_GROUPS_CLAIM ?? '').trim() || 'groups';

/**
 * The scopes asked of the pool, when the block's defaults are not enough.
 *
 * The block's default `openid email profile` is exactly what the pool's
 * federation app client allows, so a deployment normally leaves this unset.
 * It remains configuration because the failure mode of a scope mismatch is
 * "sign-in works, nobody has permissions" with nothing pointing at the cause,
 * and an operator debugging that needs a knob that does not require a code
 * change.
 */
const SCOPES = (process.env.SSO_SCOPES ?? '')
  .split(/[\s,]+/)
  .map((scope) => scope.trim())
  .filter((scope) => scope !== '');

/**
 * Whether to stand up the in-process stub IdP instead of talking to a real one.
 *
 * The stub approves sign-ins without authenticating anybody, so it is a way in
 * for whoever can reach it. Two independent conditions therefore have to hold,
 * and both of them fail closed: the dev server sets `SSO_STUB` and nothing else
 * does (`deploy.ts` and `sandbox.ts` clear it before synth), and the check
 * additionally refuses to run in any deployed compute. Neither alone is
 * trusted, because an environment variable is ambient and a runtime check
 * cannot reach synth.
 */
const USE_STUB = process.env.SSO_STUB === 'true' && !DEPLOYED;

/**
 * The secret of the pool's federation app client, for the primary provider.
 *
 * Not the external IdP's credentials — those are read by the identity provider
 * registration in `index.cdk.ts` and never reach the runtime. What this block
 * authenticates to is the pool's own token endpoint, as the confidential app
 * client the CDK creates for it; the deploy scripts read that client's secret
 * back from Cognito after each deploy and write it here, so no operator ever
 * handles it. A stored setting rather than a deploy-time value because the
 * block resolves it on the first sign-in each execution environment serves,
 * which is what lets the deploy script fill it in after the stack — including
 * the client — already exists.
 *
 * The client's id is not a secret and the block needs it as a plain string
 * when the provider is declared, so it travels with the deploy-time values
 * instead (`SSO_CLIENT_IDS` below).
 */
export const ssoClientSecret = new AppSetting(scope, 'sso-client-secret', { secret: true });

/**
 * Each provider's federation app client id, by provider name.
 *
 * Resolved by the deploy scripts from the stack outputs, after the client
 * exists, and forwarded to the backend the same way as `SSO_ISSUER_URL`. A
 * provider whose client id is not known yet is not declared: the deploy that
 * adds an entry creates its client on the first pass and declares the
 * provider on the second, as it did before the id became deploy-time.
 */
const CLIENT_IDS = parseClientIds(process.env.SSO_CLIENT_IDS);

/** The `SSO_CLIENT_IDS` value: a JSON object of provider name to client id. */
export function parseClientIds(raw: string | undefined): ReadonlyMap<string, string> {
  const text = (raw ?? '').trim();
  if (text === '') return new Map();
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === 'string' && value !== '')
  ) {
    throw new Error('SSO_CLIENT_IDS is not the object the deploy script writes. Redeploy rather than hand-edit.');
  }
  return new Map(Object.entries(parsed as Record<string, string>));
}

/**
 * The providers this deployment was synthesised with — names and labels,
 * carried in from the `sso.config.json` entries through `SSO_PROVIDERS`
 * (`sso-config.ts`). Empty on a deployment with no external IdP.
 */
const RUNTIME_PROVIDERS = runtimeSsoProviders();

/**
 * Each provider's federation-client secret. The primary entry reads the
 * unconditional setting above (its id predates multi-IdP support); every other
 * provider gets one of its own, named after it, which the deploy script fills
 * the same way.
 */
const secretSettings = new Map(
  RUNTIME_PROVIDERS.map((provider) => [
    provider.name,
    provider.primary
      ? ssoClientSecret
      : new AppSetting(scope, ssoSettingIds(provider).clientSecret, { secret: true }),
  ]),
);

/** The providers that can be declared: those whose client id is already known. */
const READY_PROVIDERS =
  ISSUER_URL !== '' ? RUNTIME_PROVIDERS.filter((provider) => CLIENT_IDS.has(provider.name)) : [];

/**
 * The configured providers, keyed by name, in the order the sign-in screen
 * shows them.
 *
 * Every entry points at the same issuer — the pool — and differs in name and
 * credentials: each external IdP stands behind an app client of its own, so
 * the hosted UI forwards a sign-in straight to its IdP instead of drawing a
 * chooser.
 */
const providers: Record<string, BuiltinProvider> =
  ISSUER_URL !== ''
    ? Object.fromEntries(
        READY_PROVIDERS.map((provider) => [
          provider.name,
          {
            // A configured issuer is talked to in every environment, local
            // development included. Pointing a developer's machine at the real
            // pool is a matter of registering `http://localhost:3000/...` on
            // the pool's federation app clients, and getting that wrong should
            // fail loudly rather than be papered over by a stub that signs
            // anybody in.
            type: 'oidc',
            issuer: ISSUER_URL,
            clientId: CLIENT_IDS.get(provider.name)!,
            clientSecret: secretSettings.get(provider.name)!,
            label: provider.label,
            ...(SCOPES.length > 0 ? { scopes: SCOPES } : {}),
          },
        ]),
      )
    : USE_STUB
      ? {
          // The key becomes the sign-in path segment
          // (`/cdk-blocks/auth/signin/sso`), matching what a real deployment
          // calls its primary provider.
          sso: stubIdp({
            // Sign in as the first local identity instead of drawing an account
            // picker. The picker is the block's default and is the more
            // realistic shape, but there is nobody to click it in the e2e
            // suite, and a federated sign-in that no test can drive is the part
            // of this feature most worth testing left untested. Which identity
            // that is, and what groups it claims, comes from
            // `.cdk-blocks/local/data/<id>/users.json` — the suite writes one.
            onAuthorize: (request) => request.users[0],
          }),
        }
      : {};

/**
 * Which providers this deployment can sign a user in with.
 *
 * The sign-in screen reads this through the API and draws one button per entry,
 * so turning federation on or off changes the screen without rebuilding the
 * frontend. Empty means the password form is the only way in. The label is the
 * entry's `label` in `sso.config.json`, or the name; the stub answers with its
 * name, which is all it has.
 */
export const federationProviders: ReadonlyArray<{ name: string; label: string }> =
  ISSUER_URL !== ''
    ? READY_PROVIDERS.map(({ name, label }) => ({ name, label }))
    : Object.keys(providers).map((name) => ({ name, label: name }));

/**
 * The configured provider name behind a Cognito IdP registration name, or
 * `undefined` for a registration this deployment does not declare.
 */
export function providerForRegistration(registration: string): string | undefined {
  return RUNTIME_PROVIDERS.find((provider) => (provider.registration ?? provider.name) === registration)
    ?.name;
}

// ─── The block ───────────────────────────────────────────────────────────────

/**
 * The OIDC sign-in gate, or `null` on a deployment with no external IdP.
 *
 * Null rather than an instance with an empty provider map, because a
 * `store: 'builtin'` block refuses to be constructed without a provider. This
 * module is imported by `access.ts`, and `access.ts` by every request path, so
 * an instance built unconditionally would take the whole backend down at
 * synth on any deployment that never asked for federation.
 *
 * Every caller therefore checks. There is exactly one (`access.ts`), and it was
 * already branching on whether federation is configured at all.
 *
 * The id `sso` and the scope are fixed: they name the block's session table.
 * It keeps the default `redirects`, because the password block in
 * `resources.ts` has no providers and so mounts no sign-in routes of its own.
 */
export const oidcAuth =
  Object.keys(providers).length > 0
    ? new Auth(scope, 'sso', {
        store: 'builtin',
        providers,
        onSignIn: (user) => syncRoleGroups(user),
        session: {
          // Matches the password block in `resources.ts`: in a sandbox the
          // frontend is served from localhost while the API answers from API
          // Gateway, which are different registrable domains, and a
          // `SameSite=Lax` cookie would not survive the round trip.
          crossDomain: getDeploymentType() === 'sandbox',
        },
      })
    : null;

// ─── Identifier canonicalisation ─────────────────────────────────────────────

/**
 * The pool `sub` behind an OIDC session's user id.
 *
 * The block names a user `${iss}:${sub}` so that two IdPs cannot collide, but
 * this deployment has exactly one issuer — its own pool — and every other part
 * of the system (permission records, the directory, `bearer-auth.ts`, the
 * password door) already names that user by the bare `sub`. Stripping the
 * prefix here, at the door, is what keeps the identifier space single.
 *
 * Only the configured issuer's prefix is stripped. Any other prefix — the
 * local stub's, or a session written under the withdrawn `${iss}:${sub}`
 * scheme — passes through unchanged, so an unexpected identifier stays visible
 * as itself instead of being folded into a `sub` it never was.
 */
export function canonicalUserId(userId: string): string {
  return canonicalUserIdFor(ISSUER_URL, userId);
}

/** The rule itself, with the issuer as an argument so tests can reach it. */
export function canonicalUserIdFor(issuerUrl: string, userId: string): string {
  if (issuerUrl !== '' && userId.startsWith(`${issuerUrl}:`)) {
    return userId.slice(issuerUrl.length + 1);
  }
  return userId;
}

// ─── Claims to role groups ───────────────────────────────────────────────────

/**
 * The IdP groups named by one sign-in's claims.
 *
 * The claim arrives in more shapes than one. An IdP that is talked to directly
 * — the local stub — emits a list, or a single string for a user in exactly
 * one group. A deployed stack reads the claim from a Cognito ID token instead,
 * where the pool has flattened the IdP's list into the string value of a
 * custom attribute: JSON (`["a","b"]`) or Cognito's own bracketed join
 * (`[a, b]`). All of those are accepted; a bracketed string is unpacked, a
 * bare string is one group. Anything else — a number, an object, absent —
 * reads as no groups, which grants nothing. Failing that way round is what
 * makes a misconfigured claim name a lockout rather than a promotion.
 */
export function groupsFromClaims(
  claims: Readonly<Record<string, unknown>>,
  claimName: string,
): string[] {
  const raw = claims[claimName];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? unpackClaimString(raw) : [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    ),
  ];
}

/**
 * The list a stringified group claim carries, or the string itself as one
 * group when it is not a packed list.
 *
 * JSON is tried first because it round-trips exactly. The bracketed fallback
 * exists for Cognito's non-JSON join, and splits on commas — safe for that
 * shape, because it only ever packs the IdP's group identifiers, and unsafe
 * shapes (a group name containing a comma) can only reach here as a real list
 * or a bare string, neither of which is split.
 *
 * Values are percent-decoded on the way out, because a packed string is by
 * definition Cognito's rendering of an attribute, and Cognito URL-encodes
 * non-ASCII characters in it — a OneLogin role named `営業部` arrives as
 * `%E5%96%B6%E6%A5%AD%E9%83%A8`, which no administrator would think to type
 * into a mapping.
 * ASCII identifiers (Entra's GUIDs) pass through decoding unchanged, and a
 * value that merely contains a stray `%` is kept as-is rather than dropped.
 */
function unpackClaimString(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [raw];
  let values: unknown[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    values = Array.isArray(parsed) ? parsed : [raw];
  } catch {
    values = trimmed.slice(1, -1).split(',');
  }
  return values.map((value) => (typeof value === 'string' ? percentDecode(value) : value));
}

/** The decoded value, or the value itself when it is not valid percent-encoding. */
function percentDecode(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * One role group's mapping entries: each names the provider whose group it
 * trusts. (The pre-multi-IdP single `idpGroup` field is no longer read — every
 * stored mapping was rewritten into this shape before that path was removed.)
 */
function idpMappingsOf(item: Item): { provider: string; group: string }[] {
  return Array.isArray(item.idpGroups) ? item.idpGroups : [];
}

/**
 * The role groups one sign-in's IdP group list reaches.
 *
 * The mapping is not a record of its own: each role group carries the entries
 * naming which provider's groups reach it, so listing the role groups *is*
 * reading the mapping. An entry only counts when its provider is the one the
 * user actually signed in through — OneLogin sends human-chosen group names,
 * so a name that happens to exist at two IdPs must not let one IdP hand out
 * the other's permissions. Group matching folds case and trims, because
 * directory group names are not case-sensitive in practice and an
 * administrator who typed `Wiki-Editors ` against a claim of `wiki-editors`
 * has made no mistake worth refusing.
 *
 * A `global: true` role group is never reachable this way, whatever its
 * entries say. `setRoleGroupIdpGroups` already refuses to write one, but the
 * refusal to *read* one is what actually holds the line: a value that arrived
 * some other way — a migration, a direct write to the table, an API added later
 * — would otherwise make "administrator of every space in the Wiki" something a
 * group membership in a system this Wiki does not control could confer. The
 * check belongs where the permission is granted, not only where it is
 * configured.
 */
export function roleGroupsForIdpGroups(
  roleGroups: Item[],
  provider: string,
  idpGroups: string[],
): string[] {
  const wanted = new Set(idpGroups.map(sortable));
  // The empty name never matches anything. `setRoleGroupIdpGroups` refuses to
  // store one, but a blank that arrived some other way — a migration, a direct
  // write — must not become reachable by a claim list that happens to carry an
  // empty string.
  wanted.delete('');
  return roleGroups
    .filter((item) => item.type === 'ROLE_GROUP' && item.global !== true)
    .filter((item) =>
      idpMappingsOf(item).some(
        (mapping) =>
          mapping.provider === provider &&
          sortable(mapping.group) !== '' &&
          wanted.has(sortable(mapping.group)),
      ),
    )
    .map((item) => idOf(item.pk));
}

/**
 * Whether a just-synchronised federated account holds any permission at all.
 *
 * `syncedRoleGroups` is the role-group set the sign-in's claims reach, so a
 * stale `ROLE_MEMBERSHIP` edge in `own` deliberately does not count — the
 * synchronisation deletes it before this is asked. `MEMBERSHIP` edges do
 * count: user groups belong to the Wiki, not the IdP, and they are the only
 * road to a federated account the IdP grants nothing — the seeded
 * administrator, and anyone an administrator placed in a user group by hand.
 * After synchronisation those two edge kinds are the only ways to any
 * permission, the global administrator included, so checking them *is*
 * checking the effective permissions.
 */
export function hasEffectivePermission(
  own: readonly Item[],
  syncedRoleGroups: ReadonlySet<string>,
): boolean {
  return syncedRoleGroups.size > 0 || own.some((item) => item.type === 'MEMBERSHIP');
}

/**
 * The refusal for a federated account that ends a synchronisation with no
 * permission at all. One message for both doors, in English like every other
 * refusal the backend writes.
 */
export class NoAccessError extends ApiError {
  constructor() {
    super(
      'This account has no access to this wiki yet. Ask a wiki administrator to grant access, then sign in again.',
      403,
      { name: 'ForbiddenException' },
    );
  }
}

/**
 * The refusal for a synchronisation that could not get its turn: another one
 * for the same account holds the record and has not finished, or took it over
 * while this one was running. Retrying shortly is the whole remedy.
 */
export class SyncBusyError extends ApiError {
  constructor() {
    super('Permissions for this account are being updated. Retry in a few seconds.', 503, {
      name: 'ServiceUnavailableException',
    });
  }
}

// ─── Synchronisation ─────────────────────────────────────────────────────────
//
// Two doors bring news of a federated account's IdP groups. A browser sign-in
// carries them in its ID token. A bearer request (MCP) carries
// none — an access token has no custom attributes — so `bearer-auth.ts` reads
// them from the pool, which rewrites them on every federated sign-in through
// any app client. Both go through `syncIdpGroups` below, so the mapping rule,
// the removal-first order and the zero-permission refusal exist once.
//
// What makes two doors safe is the account's synchronisation record
// (`USER#<sub>` / `IDP_SYNC`). It holds the newest authentication time whose
// groups have been written, and a lease that lets one synchroniser at a time
// touch the account's edges. A sign-in no newer than the recorded time is not
// written at all: a browser sign-in processed late carries the groups of its
// own moment, and must not put back an edge a newer synchronisation removed.

/**
 * How long a synchroniser may go on writing after it took the lease.
 *
 * A request is answered after 28 seconds whatever its handler is doing, and
 * the handler is not stopped: its execution environment is frozen and may
 * resume the same work much later. So a holder cannot be trusted to have
 * stopped just because its lease ran out. Instead it checks its own clock
 * against this budget before every write, and a holder thawed after the budget
 * stops at the next check — `Date.now()` has moved on while it was frozen.
 */
const SYNC_BUDGET_MS = 20 * 1000;

/**
 * How long a lease is held before another synchroniser may take it over.
 *
 * Well past the budget, so a holder still inside its budget always still holds
 * its lease. A synchroniser that fails with an error hands the lease back on
 * its way out; one that is frozen or crashes leaves it to expire, which keeps
 * that one account's sign-ins and bearer requests waiting for up to this long.
 */
const LEASE_MS = 60 * 1000;

/** Attempts at taking the lease before giving up with `SyncBusyError`. */
const LEASE_ATTEMPTS = 5;

/** What a synchronisation reads and writes, so tests can stand in for the table. */
export interface SyncStore {
  /** The synchronisation record, read with strong consistency. */
  readRecord(userId: string): Promise<Item | undefined>;
  /**
   * Write the record if its version is still `expected` (absent when there was
   * no record). `false` when the condition failed.
   */
  writeRecord(record: Item, expected: number | undefined): Promise<boolean>;
  readOwn(userId: string): Promise<Item[]>;
  readRoleGroups(): Promise<Item[]>;
  deleteEdge(userId: string, roleGroupId: string): Promise<void>;
  putEdge(edge: Item): Promise<void>;
  writeProfile(own: Item[], userId: string, email: string, provider: string): Promise<void>;
  bumpEpoch(): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const tableStore: SyncStore = {
  readRecord: async (userId) => (await table.get({ pk: userPk(userId), sk: IDP_SYNC })) ?? undefined,
  writeRecord: async (record, expected) => {
    try {
      await putItem(
        record,
        expected === undefined ? { ifNotExists: true } : { ifFieldEquals: { version: expected } },
      );
      return true;
    } catch (error: unknown) {
      if (isBlocksError(error, KVStoreErrors.ConditionalCheckFailed)) return false;
      throw error;
    }
  },
  readOwn: (userId) => valuesOf(table.query({ where: { pk: { equals: userPk(userId) } } })),
  readRoleGroups: () =>
    valuesOf(table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_ROLE_GROUPS } } })),
  deleteEdge: (userId, roleGroupId) =>
    table.delete({ pk: userPk(userId), sk: roleGroupPk(roleGroupId) }),
  putEdge: (edge) => putItem(edge),
  writeProfile,
  bumpEpoch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One synchronisation request. */
export type SyncInput = {
  userId: string;
  /** The `auth_time` of the sign-in whose groups are being applied, in seconds. */
  authTime: number;
  /**
   * Where the groups come from: the ID token's claims, or the pool. Called only
   * once this synchroniser holds the lease, so what it reads is no older than
   * the moment the account's edges are rewritten.
   */
  load: () => Promise<{ provider: string; groups: string[] }>;
  /** The browser door's directory write. The bearer door never creates one. */
  profileEmail?: string;
};

/**
 * Where a synchronisation left the account.
 *
 * `own` is the user's partition as it now stands, so a caller can walk the
 * permissions without reading it again. `changed` says whether any edge moved
 * — and so whether the permission epoch did.
 */
export type SyncResult = { applied: boolean; changed: boolean; own: Item[] };

/**
 * Bring a federated account's direct role-group edges up to what its IdP says.
 *
 * Additive synchronisation was rejected: it cannot express a removal, so a user
 * taken out of a group at the IdP would keep the permission here forever, and
 * the whole point of delegating to the IdP is that the IdP is where the answer
 * lives. Edges the groups no longer name are therefore deleted.
 *
 * Only `ROLE_MEMBERSHIP` is rewritten. User-group membership belongs to the
 * Wiki and is left alone — that is what lets `seed-admin` grant an
 * administrator who signs in through the IdP, and what keeps an IdP
 * misconfiguration from locking every administrator out at once.
 *
 * A sign-in no newer than the one already applied returns `applied: false`
 * with the partition untouched; deciding whether that partition grants
 * anything is the caller's.
 *
 * Throws `NoAccessError` when the account ends with no permission, and
 * `SyncBusyError` when it cannot get the lease.
 */
export async function syncIdpGroups(
  input: SyncInput,
  store: SyncStore = tableStore,
): Promise<SyncResult> {
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await store.sleep(150 * attempt);
    const record = await store.readRecord(input.userId);
    const syncedAuthTime = record?.syncedAuthTime ?? 0;
    if (input.authTime <= syncedAuthTime) {
      return { applied: false, changed: false, own: await store.readOwn(input.userId) };
    }
    // Someone else is mid-way. Their result may make this one unnecessary, so
    // wait and start again from the read.
    if (record?.leaseUntil !== undefined && record.leaseUntil > store.now()) continue;

    const lease: Item = {
      pk: userPk(input.userId),
      sk: IDP_SYNC,
      type: 'IDP_SYNC',
      syncedAuthTime,
      ...(record?.roleGroupIds !== undefined ? { roleGroupIds: record.roleGroupIds } : {}),
      leaseUntil: store.now() + LEASE_MS,
      version: record === undefined ? 0 : (record.version ?? 0) + 1,
    };
    if (!(await store.writeRecord(lease, record === undefined ? undefined : (record.version ?? 0)))) {
      continue;
    }
    return await applyHeld(input, store, lease);
  }
  throw new SyncBusyError();
}

/** The synchronisation proper, run while holding `lease`. */
async function applyHeld(input: SyncInput, store: SyncStore, lease: Item): Promise<SyncResult> {
  const { userId } = input;
  const version = lease.version ?? 0;
  const deadline = store.now() + SYNC_BUDGET_MS;
  const previous = lease.roleGroupIds ?? [];
  let recorded = previous;
  const release = async (syncedAuthTime: number, roleGroupIds: string[]): Promise<void> => {
    const { leaseUntil: _held, ...rest } = lease;
    // Losing this write means the lease expired and somebody else took the
    // record over; their run supersedes this one, so there is nothing to undo.
    await store.writeRecord(
      { ...rest, syncedAuthTime, roleGroupIds, version: version + 1 },
      version,
    );
  };
  // Called before every write. Past the budget the lease may already be
  // somebody else's (see `SYNC_BUDGET_MS`); a version that moved means it is.
  const stillHeld = async (): Promise<void> => {
    if (store.now() > deadline) throw new SyncBusyError();
    const current = await store.readRecord(userId);
    if (current?.version !== version) throw new SyncBusyError();
  };

  let edgesTouched = false;
  try {
    const { provider, groups } = await input.load();
    const [own, roleGroups] = await Promise.all([store.readOwn(userId), store.readRoleGroups()]);

    const wanted = new Set(roleGroupsForIdpGroups(roleGroups, provider, groups));
    const held = new Set(
      own.filter((item) => item.type === 'ROLE_MEMBERSHIP').map((item) => idOf(item.sk)),
    );
    const toAdd = [...wanted].filter((id) => !held.has(id));
    // The partition read is eventually consistent, so an edge the previous
    // synchronisation wrote a moment ago may be missing from it. The record is
    // read strongly and lists what that synchronisation wrote, so those are
    // removed as well when no longer wanted; deleting an edge that is already
    // gone does nothing.
    const toRemove = new Set(
      [...held, ...previous].filter((id) => !wanted.has(id)),
    );
    // Whatever happens next, the record goes on naming every edge this run may
    // leave behind, so a later run can find them without the partition read.
    recorded = [...new Set([...previous, ...wanted])];

    // Removals are completed and announced before anything else runs. The two
    // directions fail differently: an addition that lands while a later step
    // throws costs the user a permission they should have, until the backstop
    // TTL expires. A removal in the same position is a permission this Wiki has
    // revoked and every warm execution environment goes on handing out for the
    // same five minutes. Only one of those is worth ordering around, so the
    // revocation runs first and moves the generation immediately.
    if (toRemove.size > 0) {
      await stillHeld();
      edgesTouched = true;
      await Promise.all([...toRemove].map((roleGroupId) => store.deleteEdge(userId, roleGroupId)));
      await store.bumpEpoch();
    }

    // A federated account that ends with no permissions at all is turned away
    // at the door rather than let in to an empty screen. The check sits above
    // the profile write so a rejected visitor never appears in the user
    // directory, and below the removals so a revocation down to zero still
    // lands before the refusal. The result is recorded like any other, so the
    // same sign-in is not synchronised again on every request it makes.
    if (!hasEffectivePermission(own, wanted)) {
      await release(input.authTime, []);
      throw new NoAccessError();
    }

    if (input.profileEmail !== undefined) {
      if (store.now() > deadline) throw new SyncBusyError();
      await store.writeProfile(own, userId, input.profileEmail, provider);
    }

    const added: Item[] = [];
    if (toAdd.length > 0) {
      // The last point before a grant is written. A holder that has lost its
      // lease — it outlived it and somebody took over — must not write one.
      await stillHeld();
      edgesTouched = true;
      const at = new Date(store.now()).toISOString();
      for (const roleGroupId of toAdd) {
        added.push({
          pk: userPk(userId),
          sk: roleGroupPk(roleGroupId),
          type: 'ROLE_MEMBERSHIP',
          gsi1pk: roleGroupPk(roleGroupId),
          gsi1sk: userPk(userId),
          addedAt: at,
          addedBy: `idp:${provider}`,
        });
      }
      await Promise.all(added.map((edge) => store.putEdge(edge)));
      await store.bumpEpoch();
    }

    // Nothing moved, so nothing is announced. Bumping on every sign-in would
    // throw away every execution environment's resolved answers for every user
    // each time anybody signed in, which is the cost this counter exists to
    // avoid.
    await release(input.authTime, [...wanted]);
    return {
      applied: true,
      changed: toRemove.size > 0 || added.length > 0,
      own: [
        ...own.filter(
          (item) => !(item.type === 'ROLE_MEMBERSHIP' && toRemove.has(idOf(item.sk))),
        ),
        ...added,
      ],
    };
  } catch (error: unknown) {
    if (error instanceof NoAccessError) throw error;
    // Hand the lease back without advancing the recorded time, so the next
    // request starts over rather than waiting out the lease. Best effort: if it
    // fails too, the lease expiring is the fallback.
    await release(lease.syncedAuthTime ?? 0, recorded).catch(() => undefined);
    if (edgesTouched) await store.bumpEpoch().catch(() => undefined);
    throw error;
  }
}

/**
 * The browser door: synchronise from the sign-in's own ID token.
 *
 * Throwing here fails the sign-in and sets no cookie, which is deliberate: a
 * session whose permissions could not be established should not exist.
 */
async function syncRoleGroups(user: AuthenticatedUser): Promise<void> {
  const userId = canonicalUserId(user.userId);
  // The same fallback `access.ts` uses when it reads a federated session. Two
  // different ones would fight: an IdP that supplies no address would have this
  // write the empty string, the next request write the display name, and the
  // next sign-in write the empty string again — rewriting the directory's sort
  // key, and reordering the account list, on every round.
  const email = user.attributes.email ?? user.username;
  // The provider key in this block's `providers`: the configured name.
  const provider = user.signInProvider;
  const claims = user.claims ?? {};

  const result = await syncIdpGroups({
    userId,
    authTime: authTimeOf(claims, Date.now()),
    load: async () => ({ provider, groups: groupsFromClaims(claims, GROUPS_CLAIM) }),
    profileEmail: email,
  });
  if (result.applied) return;

  // A newer sign-in has already been applied, so this one's claims are stale
  // and the edges stay as they are. The sign-in itself still stands, under the
  // same rule as every other: it is refused when the edges grant nothing.
  if (!hasEffectivePermission(result.own, directRoleGroups(result.own))) throw new NoAccessError();
  await writeProfile(result.own, userId, email, provider);
}

/** The role groups a user's partition names directly. */
export function directRoleGroups(own: readonly Item[]): Set<string> {
  return new Set(own.filter((item) => item.type === 'ROLE_MEMBERSHIP').map((item) => idOf(item.sk)));
}

/**
 * The sign-in time a token's claims state, in seconds.
 *
 * Cognito puts `auth_time` in both its ID and access tokens, and so does the
 * local stub IdP. This is the fallback for a token without one: the sign-in is
 * taken to have happened now, which is the same reading the `Auth` block gives
 * such a token — the hook runs a moment after the sign-in it reports. The
 * fallback keeps the milliseconds, so two such sign-ins a moment apart are
 * still told apart.
 */
export function authTimeOf(claims: Readonly<Record<string, unknown>>, nowMs: number): number {
  const value = claims.auth_time;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : nowMs / 1000;
}

/**
 * Record the account in the user directory, or refresh what is displayed of it.
 *
 * `access.ts` provisions a directory record on first sign-in too, but only from
 * what a session carries. Writing it here is what puts `identityProvider` on
 * it, which is how the management screens know not to offer edits the next
 * sign-in would undo.
 */
async function writeProfile(
  own: Item[],
  userId: string,
  email: string,
  // The door the sign-in actually came through, not a configured constant:
  // with more than one provider the record has to say which one owns this
  // account.
  provider: string,
): Promise<void> {
  const profile = own.find((item) => item.type === 'USER');

  if (profile === undefined) {
    await putItem({
      pk: userPk(userId),
      sk: PROFILE,
      type: 'USER',
      gsi1pk: ALL_USERS,
      gsi1sk: sortable(email),
      email,
      identityProvider: provider,
      createdAt: new Date().toISOString(),
      version: 0,
    });
    return;
  }

  if (profile.email === email && profile.identityProvider === provider) return;
  // A concurrent sign-in in another tab writing the same values is the
  // expected loser here, and the display address is not worth a failed
  // sign-in.
  await putItem(
    {
      ...profile,
      email,
      gsi1sk: sortable(email),
      identityProvider: provider,
      version: (profile.version ?? 0) + 1,
    },
    { ifFieldEquals: { version: profile.version ?? 0 } },
  ).catch(() => undefined);
}

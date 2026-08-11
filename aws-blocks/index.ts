/**
 * Backend — aws-blocks/index.ts
 *
 * Defines the API. The frontend imports these exports directly via
 * `import { ... } from 'aws-blocks'`.
 *
 * Building Block instances live in `resources.ts`, the stored shape and key
 * helpers in `model.ts`, and permission resolution in `access.ts`.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or local databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 *
 * ApiNamespace methods are unauthenticated by default. Every method below opens
 * with `requireAccess(context)`; there is no public method in this namespace.
 * Authentication alone is never enough — operations on a space go through
 * `requireSpace`, and management operations through `requireGlobalAdmin`.
 *
 * API reference for the installed versions: the README of each block under
 * node_modules/@aws-blocks/
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ApiNamespace } from '@aws-blocks/blocks';

import { auth, scope, table } from './resources.js';
import {
  ALL_ROLE_GROUPS,
  ALL_SPACES,
  ALL_USERS,
  ALL_USER_GROUPS,
  CLEANUP_PK,
  CONFIG_DEFAULTS,
  CONFIG_PK,
  META,
  PAGE_SK_PREFIX,
  PERMISSIONS,
  PROFILE,
  SYSTEM_ADMIN_ROLE_GROUP,
  SYSTEM_ADMIN_USER_GROUP,
  type Item,
  type Permission,
  idOf,
  roleGroupPk,
  sortable,
  spacePk,
  userGroupPk,
  userPk,
} from './model.js';
import {
  deletePageRecords,
  promiseReclaim,
  spaceReclaimPrefix,
  submitReclaim,
} from './pages.js';
import {
  createAttachmentDownloadUrl as createDownloadUrl,
  createAttachmentDownloadUrls as createDownloadUrls,
  createAttachmentUploadUrl as createUploadUrl,
  deleteAttachment as removeAttachment,
  listAttachments as listPageAttachments,
} from './attachment-ops.js';
import { reclaimJob } from './reclaim.js';
import { requestKeywordIndex } from './keyword-index.js';
import { deleteCorpusBatch, requestReingest } from './search-corpus.js';
import {
  type ViewingClaim,
  createFolder as createWikiFolder,
  createPage as createWikiPage,
  deleteFolder as deleteWikiFolder,
  deletePage as deleteWikiPage,
  listChildPages as listChildWikiPages,
  listPages as listWikiPages,
  movePage as moveWikiPage,
  mySpaces as readableSpacesOf,
  readFolderDetail,
  readPageDetail,
  renameFolder as renameWikiFolder,
  requireOneLine,
  resolveViewing,
  searchPages,
  suggestPages,
  updatePage as updateWikiPage,
} from './wiki-ops.js';
// Imported for its side effect: the module constructs the `RawRoute`s of the
// external sync API, and a route only exists once its construct is
// built. Nothing here calls into it.
import './ext.js';
import { assistant, type ApprovalDecision } from './assistant.js';
import { isViewingLocale, withViewing, withoutViewing } from './viewing.js';
import { withoutDiscardedReplies } from './transcript.js';
// Imported for its side effect: the module constructs the `RawRoute`s that make
// up the MCP server, and a route only exists once its construct is built.
// Nothing here calls into it.
import './mcp.js';
import {
  type Access,
  bumpEpoch,
  conflict,
  forbidden,
  invalid,
  isConditionalFailure,
  notFound,
  requireAccess,
  requireGlobalAdmin,
  requireSpace,
  swallowConditionalFailure,
} from './access.js';

export const authApi = auth.createApi();

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/**
 * An optional string argument, as the API should read it.
 *
 * An argument the caller left out arrives as `null` rather than `undefined`
 * when it sits before one that was supplied, because that is what JSON carries;
 * an empty form field arrives as `''`. Neither is a value. The distinction
 * matters most for cursors: reading `null` as a real cursor asks for the rows
 * after it and finds none, so a first page comes back empty and the caller sees
 * "there is nothing here" instead of a mistake.
 */
const given = (value: string | null | undefined): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : value;

// ─── Response shapes ─────────────────────────────────────────────────────────
// The envelope stored in DynamoDB is an implementation detail; callers see the
// entity, with the key prefixes stripped.

const asSpace = (item: Item) => ({
  spaceId: idOf(item.pk),
  name: item.name ?? '',
  description: item.description ?? '',
  createdAt: item.createdAt,
  version: item.version ?? 0,
});

const asGroup = (item: Item) => ({
  id: idOf(item.pk),
  name: item.name ?? '',
  description: item.description ?? '',
  system: item.system === true,
  global: item.global === true,
});

// No `displayName`: nothing writes one yet, so returning it would promise a
// field that is always absent. It goes in with the user-profile work.
const asUser = (item: Item) => ({
  userId: idOf(item.pk),
  email: item.email ?? '',
});

/**
 * Validate a name at the API boundary.
 *
 * `itemSchema` enforces the same bounds, but a schema rejection surfaces as the
 * block's `ValidationFailedException`, which reads to a client as a server
 * fault rather than bad input.
 */
function cleanName(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') invalid('A name is required');
  if (trimmed.length > 200) invalid('A name may be at most 200 characters');
  // A space name is read back on one line in the assistant's screen block, the
  // same as a page title (`requireOneLine` in `wiki-ops.ts` says why).
  requireOneLine(trimmed, 'name');
  return trimmed;
}

function cleanDescription(value: string): string {
  if (value.length > 2000) invalid('A description may be at most 2000 characters');
  return value;
}

/** Delete every item an index query returns. Re-running finishes a partial run. */
async function deleteByIndex(gsi1pk: string, gsi1skPrefix?: string): Promise<void> {
  const items = await Array.fromAsync(
    table.query({
      index: 'gsi1',
      where: {
        gsi1pk: { equals: gsi1pk },
        ...(gsi1skPrefix === undefined ? {} : { gsi1sk: { beginsWith: gsi1skPrefix } }),
      },
    }),
  );
  if (items.length > 0) {
    await table.deleteBatch(items.map((item) => ({ pk: item.pk, sk: item.sk })));
  }
}

async function requireItem(pk: string, sk: string, what: string): Promise<Item> {
  const item = await table.get({ pk, sk });
  if (item === null) notFound(`${what} not found`);
  return item;
}

/** Turn a lost optimistic-lock race into a 409 instead of leaking the block's error. */
function asConflict(what: string) {
  return (error: unknown): never => {
    if (isConditionalFailure(error)) conflict(`${what} changed since it was read; reload and retry`);
    throw error;
  };
}

/**
 * User groups that reach the global administrator role group.
 *
 * Being a global administrator is "reaches a role group with `global: true`",
 * not "is in `ug_admins`" — the bootstrap group is only the one the bootstrap
 * happens to build. Anything guarding the administrator population has to ask
 * the same question the permission resolver asks, or it guards the wrong set.
 */
async function adminUserGroupIds(): Promise<string[]> {
  const attachments = await Array.fromAsync(
    table.query({
      index: 'gsi1',
      where: {
        gsi1pk: { equals: roleGroupPk(SYSTEM_ADMIN_ROLE_GROUP) },
        gsi1sk: { beginsWith: 'UG#' },
      },
    }),
  );
  return attachments.map((item) => idOf(item.gsi1sk ?? ''));
}

/**
 * Would the Wiki still have a global administrator after this edge is cut?
 *
 * `drop` names the edge under consideration: a membership (both fields) or an
 * attachment (`userGroupId` alone). The count is taken from `gsi1`, which is
 * eventually consistent, so a membership written moments ago may be invisible
 * and make this answer conservative. Erring toward refusing the removal is the
 * safe direction: the opposite error empties the administrator population, and
 * getting back out of that takes AWS credentials and `scripts/seed-admin.ts`,
 * because no API can raise anyone's own permissions.
 */
async function adminsRemainWithout(drop: { userGroupId: string; userId?: string }): Promise<boolean> {
  const groupIds = (await adminUserGroupIds()).filter(
    (id) => drop.userId !== undefined || id !== drop.userGroupId,
  );
  const memberships = await Promise.all(
    groupIds.map((id) =>
      Array.fromAsync(
        table.query({
          index: 'gsi1',
          where: { gsi1pk: { equals: userGroupPk(id) }, gsi1sk: { beginsWith: 'USER#' } },
        }),
      ),
    ),
  );
  const remaining = new Set<string>();
  groupIds.forEach((groupId, i) => {
    for (const membership of memberships[i] ?? []) {
      const userId = idOf(membership.pk);
      if (groupId === drop.userGroupId && userId === drop.userId) continue;
      remaining.add(userId);
    }
  });
  return remaining.size > 0;
}

/** Is there any global administrator at all right now? Drops no edge. */
const anyGlobalAdminRemains = () => adminsRemainWithout({ userGroupId: '' });

/** Does this user group confer global administrator through any attachment? */
async function reachesGlobalAdmin(userGroupId: string): Promise<boolean> {
  const attachments = await Array.fromAsync(
    table.query({
      where: { pk: { equals: userGroupPk(userGroupId) }, sk: { beginsWith: 'RG#' } },
    }),
  );
  if (attachments.length === 0) return false;
  const roleGroups = await table.getBatch(attachments.map((item) => ({ pk: item.sk, sk: META })));
  return roleGroups.some((item) => item?.global === true);
}

// ─── AI assistant ────────────────────────────────────────────────────────────

/** A single message to the assistant. Long enough for a pasted excerpt. */
const MAX_ASSISTANT_MESSAGE = 4000;

/**
 * Confirm the caller owns this conversation.
 *
 * The Agent block scopes conversations by an unguessable UUID but does not
 * authorize reads: `getConversation(id)` and `getPendingInterrupts(id)` take an
 * id and nothing else, so anyone holding one gets the messages. A UUID is not a
 * permission. `listConversations(userId)` is owner-scoped, so it is what decides
 * here.
 *
 * Reported as absent rather than forbidden, for the same reason a space the
 * caller cannot read is: confirming that an id exists is already more than a
 * non-owner should learn.
 */
async function requireOwnConversation(access: Access, conversationId: string): Promise<void> {
  if (conversationId === '') notFound('Conversation not found');
  const owned = await assistant.listConversations(access.user.userSub);
  if (!owned.some((item) => item.conversationId === conversationId)) {
    notFound('Conversation not found');
  }
}

/**
 * The approval decisions a client may send back, reduced to yes or no.
 *
 * The block also understands "trust", which auto-approves a tool for the rest of
 * the conversation. That is not offered: every write goes past the user, every
 * time, and dropping the field here means no client can opt out of
 * that by sending one more property.
 */
function cleanApprovalDecisions(responses: ApprovalDecision[]): ApprovalDecision[] {
  if (!Array.isArray(responses) || responses.length === 0) {
    invalid('At least one approval decision is required');
  }
  return responses.map((response) => {
    if (typeof response?.interruptId !== 'string' || response.interruptId === '') {
      invalid('Each approval decision needs an interruptId');
    }
    return { interruptId: response.interruptId, approved: response.approved === true };
  });
}

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  /**
   * Identity and reach of the signed-in user.
   *
   * `userId` is the Cognito-assigned `sub`, the key every permission record
   * points at. The email address is a display value only.
   */
  async me() {
    const access = await requireAccess(context);
    return {
      userId: access.user.userSub,
      email: access.user.email,
      isGlobalAdmin: access.isGlobalAdmin,
      // `null` rather than an omitted field: a global administrator reaches
      // every space, so there is no meaningful count, but the shape of the
      // response should not change between callers.
      spaceCount: access.isGlobalAdmin ? null : access.spaces.size,
    };
  },

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Search over page text, semantic and keyword fused into one ranking.
   *
   * The work is in `searchPages`, which the assistant's `searchWiki` tool calls
   * too — including the `filterReadable` gate every hit passes through.
   */
  async search(query: string, options?: { spaceId?: string; limit?: number }) {
    const access = await requireAccess(context);
    return await searchPages(access, query, options);
  },

  /**
   * Suggestions while the query is still being typed.
   *
   * Called on keystrokes, so it runs only the searches that answer from the
   * handler's own memory — see `suggestPages`, which also holds the same
   * `filterReadable` gate the full search passes through.
   */
  async suggest(query: string, options?: { spaceId?: string; limit?: number }) {
    const access = await requireAccess(context);
    return await suggestPages(access, query, options);
  },

  // ─── AI assistant ────────────────────────────────────────────────────────
  // Six methods, one conversation id. The channel the answer streams on is the
  // conversation id itself rather than a separate value the client picks, so
  // "may I read this conversation" and "may I subscribe to this stream" are the
  // same question, answered by `requireOwnConversation` in every method here.

  /** Open a conversation. The id is what every other method below is keyed on. */
  async startAssistantConversation() {
    const access = await requireAccess(context);
    return { conversationId: await assistant.createConversationId(access.user.userSub) };
  },

  /**
   * Send a message and let the agent answer on the conversation's channel.
   *
   * Returns as soon as the work is queued — the agent runs in the block's async
   * job and publishes to Realtime, so nothing here waits on a model.
   * The client must already be subscribed; `useChat` handles that ordering.
   *
   * `context: { userId }` is what the tools act as. It comes from the resolved
   * session and is never read back from the model's output.
   *
   * `viewing` is the screen the caller has open. The client is the only party
   * that knows it, and without it "fix this page" reaches the agent with
   * nothing for "this" to point at — which is why the assistant used to go
   * searching for a page the user was already looking at. It is resolved and
   * gated here (`resolveViewing`), then prepended to the message as the block
   * `assistant.ts` describes. The length bound applies to what the user typed,
   * not to the lines the server adds.
   *
   * `locale` is the language the screen is being read in, and it rides in the
   * same block so the answer comes back in it. It is checked against the two
   * the app has rather than passed through: it lands inside the model's input,
   * where an arbitrary string from a caller would be an instruction the caller
   * wrote. Anything else is dropped, and the prompt's own default applies.
   */
  async sendAssistantMessage(
    conversationId: string,
    message: string,
    viewing?: ViewingClaim,
    locale?: string,
  ) {
    const access = await requireAccess(context);
    await requireOwnConversation(access, conversationId);
    const text = message.trim();
    if (text === '') invalid('A message is required');
    if (text.length > MAX_ASSISTANT_MESSAGE) {
      invalid(`A message may be at most ${MAX_ASSISTANT_MESSAGE} characters`);
    }
    const said = isViewingLocale(locale) ? locale : null;
    await assistant.stream(withViewing(text, await resolveViewing(access, viewing), said), {
      conversationId,
      channelId: conversationId,
      userId: access.user.userSub,
      context: { userId: access.user.userSub },
    });
    return { conversationId };
  },

  /**
   * The conversation as the panel shows it.
   *
   * Only the three roles the UI renders. The stored history also holds tool-call
   * and tool-result records — a raw page body, a tool's whole return value — and
   * those stay in DynamoDB as the audit trail rather than coming back out here.
   *
   * Note this is not a permission boundary. The assistant's own answers are
   * returned, and an answer quotes what the tools found, so a caller whose access
   * was revoked after the fact can still re-read their own transcript. Whether a
   * conversation should stay readable that long is an open question.
   */
  async getAssistantConversation(conversationId: string) {
    const access = await requireAccess(context);
    await requireOwnConversation(access, conversationId);
    const messages = await assistant.getConversation(conversationId);
    return {
      messages: withoutDiscardedReplies(
        messages
          .filter(
            (item) => item.role === 'user' || item.role === 'assistant' || item.role === 'approval',
          )
          // A user turn is stored with the screen block `sendAssistantMessage`
          // prepended. The panel should redraw what the user typed, so it comes
          // back off here; the stored copy keeps it as the record of what the
          // agent was actually asked.
          .map((item) => ({
            role: item.role,
            content: item.role === 'user' ? withoutViewing(item.content) : item.content,
          })),
      ),
    };
  },

  /** The Realtime channel the answer streams on. Hydrated into a handle client-side. */
  async getAssistantChannel(conversationId: string) {
    const access = await requireAccess(context);
    await requireOwnConversation(access, conversationId);
    return await assistant.getChannel(conversationId);
  },

  /**
   * Answer a pending tool approval and let the agent continue.
   *
   * Approving is permission to *attempt* the tool, not permission to perform it:
   * the handler still resolves the user's rights and refuses a write to a space
   * they cannot write.
   */
  async resumeAssistant(conversationId: string, responses: ApprovalDecision[]) {
    const access = await requireAccess(context);
    await requireOwnConversation(access, conversationId);
    await assistant.resume(conversationId, cleanApprovalDecisions(responses), {
      conversationId,
      userId: access.user.userSub,
      context: { userId: access.user.userSub },
    });
    return { conversationId };
  },

  /** Approvals still waiting — what a reload has to redraw. */
  async getAssistantPendingInterrupts(conversationId: string) {
    const access = await requireAccess(context);
    await requireOwnConversation(access, conversationId);
    return { interrupts: await assistant.getPendingInterrupts(conversationId) };
  },

  // ─── Spaces ────────────────────────────────────────────────────────────────

  /** Spaces the caller may read, with the permission held on each. */
  async mySpaces() {
    const access = await requireAccess(context);
    return await readableSpacesOf(access);
  },

  async listSpaces() {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const items = await Array.fromAsync(
      table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_SPACES } } }),
    );
    return items.map(asSpace);
  },

  async getSpace(spaceId: string) {
    const access = await requireAccess(context);
    const permission = requireSpace(access, spaceId, 'read');
    const item = await requireItem(spacePk(spaceId), META, 'Space');
    return { ...asSpace(item), permission };
  },

  async createSpace(input: { name: string; description?: string }) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const name = cleanName(input.name);
    const spaceId = newId();
    await table.put(
      {
        pk: spacePk(spaceId),
        sk: META,
        type: 'SPACE',
        gsi1pk: ALL_SPACES,
        gsi1sk: sortable(name),
        name,
        description: cleanDescription(input.description ?? ''),
        createdAt: now(),
        version: 0,
      },
      { ifNotExists: true },
    );
    return { spaceId };
  },

  /** Rename or re-describe a space. `version` guards against a lost update. */
  async updateSpace(spaceId: string, patch: { name?: string; description?: string; version: number }) {
    const access = await requireAccess(context);
    requireSpace(access, spaceId, 'admin');
    const item = await requireItem(spacePk(spaceId), META, 'Space');
    const name = cleanName(patch.name ?? item.name ?? '');
    // Composed field by field rather than spread over `item`. A spread carries
    // whatever the stored record happens to hold, so the same shape copied to a
    // future `updateRoleGroup` would let a caller-supplied `global` through.
    await table
      .put(
        {
          pk: item.pk,
          sk: item.sk,
          type: 'SPACE',
          gsi1pk: ALL_SPACES,
          gsi1sk: sortable(name),
          name,
          description: cleanDescription(patch.description ?? item.description ?? ''),
          createdAt: item.createdAt,
          version: patch.version + 1,
        },
        { ifFieldEquals: { version: patch.version } },
      )
      .catch(asConflict('Space'));
    return { version: patch.version + 1 };
  },

  /**
   * Removes the space, every grant pointing at it, and every page in it.
   *
   * The S3 objects are not deleted here. A reclamation record is written first,
   * naming the `spaces/<spaceId>/` prefix, and the job empties it afterwards.
   * The object count of a space has no ceiling, so sweeping it inside the
   * request would be unbounded work behind API Gateway's 29-second limit, and
   * an interrupted sweep would leave nothing recording how far it got.
   *
   * Order matters at both ends. The promise is written first, so that any
   * later failure still leaves it behind and the metadata deletions can be
   * re-run freely — that is how a partial delete converges. The job is
   * submitted last, because it empties the prefix: started any earlier, it
   * could remove the bodies of pages this request has not deleted yet, leaving
   * readable pages with no text in them.
   */
  async deleteSpace(spaceId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);

    const reclaiming = await promiseReclaim([spaceReclaimPrefix(spaceId)]);

    // Grants hang off `gsi1pk = SPACE#<id>`; pages sit under `PARENT#SPACE#<id>`
    // and are untouched by this sweep, which is why the page index took its own
    // namespace.
    await deleteByIndex(spacePk(spaceId));
    // Right here, not at the end: the grants are already gone, and the page sweep
    // below is unbounded and may time out. Moving the generation now means a run
    // that never reaches the last line still invalidated the answers that named
    // this space.
    await bumpEpoch();

    // Paged rather than collected: a space's page count is unbounded, and each
    // round is a complete unit of work, so a timeout only costs the rounds not
    // yet done. Re-invoking finishes the job.
    for (;;) {
      const batch = await Array.fromAsync(
        table.query({
          where: { pk: { equals: spacePk(spaceId) }, sk: { beginsWith: PAGE_SK_PREFIX } },
          limit: 100,
        }),
      );
      if (batch.length === 0) break;
      // Corpus documents go with the page metadata, one round at a time, so a
      // re-invocation after a timeout resumes cleanly — the pages whose corpus
      // is gone are the same ones whose metadata is gone. Best-effort: a corpus
      // delete that fails must not strand the space delete (a derived-index ghost
      // is dropped on read), so it is swallowed and the metadata delete proceeds.
      await deleteCorpusBatch(batch.map((item) => ({ spaceId, pageId: idOf(item.sk) }))).catch(
        () => {},
      );
      await deletePageRecords(batch);
    }

    await table.delete({ pk: spacePk(spaceId), sk: META });
    await submitReclaim(reclaiming);
    await requestReingest();
    // The corpus prefix is empty now, so this rebuild removes the space's
    // keyword index file rather than writing one.
    await requestKeywordIndex(spaceId);
    return { spaceId };
  },

  // ─── Pages ─────────────────────────────────────────────────────────────────
  // Reading needs `read` on the space, writing needs `write`. The space is
  // resolved before any gate runs, and for callers holding only a page id it is
  // resolved from the locator record — never taken from the caller, which would
  // let someone with access to one space name another space's page.

  /**
   * Every page in a space, in key order, one page of results at a time.
   *
   * Served from the primary key rather than an index, because this listing is
   * the one that must not miss a row: reindexing, export, and the metadata half
   * of a space delete all ride on it, and `gsi1` is only eventually consistent.
   *
   * Keyset paging, per the contract `findUsers()` settled: pass the previous
   * `nextCursor` back, and `null` means this was the last page.
   */
  async listPages(spaceId: string, cursor?: string | null) {
    const access = await requireAccess(context);
    return await listWikiPages(access, spaceId, cursor);
  },

  /**
   * The direct children of a page, or of the space root when `parentPageId` is
   * null — the query the tree view expands one node at a time.
   *
   * Shared with the MCP server's `listChildPages` tool, which reaches the same
   * function.
   */
  async listChildPages(spaceId: string, parentPageId: string | null, cursor?: string | null) {
    const access = await requireAccess(context);
    return await listChildWikiPages(access, spaceId, parentPageId, cursor);
  },

  /**
   * A page with its body and its breadcrumb.
   *
   * `knownStamp` lets a client that already holds a body say so; the body comes
   * back only when it has changed since. Omitting it returns the body
   * every time, which is what every caller did before the argument existed.
   */
  async getPage(pageId: string, knownStamp?: string | null) {
    const access = await requireAccess(context);
    return await readPageDetail(access, pageId, knownStamp);
  },

  /**
   * Create a page, optionally under a parent, at the end of its siblings.
   *
   * Shared with the assistant's `createPage` tool, which reaches the same
   * function after the user approves the call.
   */
  async createPage(input: {
    spaceId: string;
    parentPageId?: string | null;
    title: string;
    body?: string;
  }) {
    const access = await requireAccess(context);
    return await createWikiPage(access, input);
  },

  /** Save a new title, a new body, or both. Last writer wins. */
  async updatePage(pageId: string, patch: { title?: string; body?: string }) {
    const access = await requireAccess(context);
    return await updateWikiPage(access, pageId, patch);
  },

  /**
   * Reparent a page, reorder it among its siblings, or both.
   *
   * One item is written, however large the subtree: the descendants keep
   * pointing at their own parents, and nothing stores a path that would have to
   * follow. `afterPageId` names the sibling to land behind — `null` for first,
   * omitted for last.
   *
   * Moving between spaces is not offered. It would change the partition key,
   * relocate the S3 objects, and rewrite the locator record, with no way to
   * make the three agree if the call died in the middle.
   */
  async movePage(
    pageId: string,
    target: { parentPageId?: string | null; afterPageId?: string | null },
  ) {
    const access = await requireAccess(context);
    return await moveWikiPage(access, pageId, target);
  },

  /**
   * Delete a page.
   *
   * A page with children is refused unless the caller says what should happen
   * to them, and the refusal carries the count. Neither default is safe to pick
   * silently: cascading would delete pages nobody asked about, and reparenting
   * would reshape the tree behind the caller's back.
   *
   * The S3 objects go to the reclamation job, as with a space.
   */
  async deletePage(pageId: string, children: 'reject' | 'cascade' | 'reparent' = 'reject') {
    const access = await requireAccess(context);
    return await deleteWikiPage(access, pageId, children);
  },

  // ─── Folders ───────────────────────────────────────────────────────────────
  // The other kind of node. Same partition, same index, same gates: reading
  // needs `read` on the space, writing needs `write`, and the space comes from
  // the locator record whenever the caller holds only an id.

  /** Create a folder, optionally inside another, at the end of its siblings. */
  async createFolder(input: { spaceId: string; parentPageId?: string | null; title: string }) {
    const access = await requireAccess(context);
    return await createWikiFolder(access, input);
  },

  /** A folder's name and breadcrumb. Its contents come from `listChildPages`. */
  async getFolder(folderId: string) {
    const access = await requireAccess(context);
    return await readFolderDetail(access, folderId);
  },

  /** Rename a folder. There is nothing else about a folder to edit. */
  async renameFolder(folderId: string, title: string) {
    const access = await requireAccess(context);
    return await renameWikiFolder(access, folderId, title);
  },

  /**
   * Delete a folder.
   *
   * A folder holding anything is refused unless the caller says what happens to
   * the contents, exactly as `deletePage` does, and for the same reason.
   */
  async deleteFolder(folderId: string, children: 'reject' | 'cascade' | 'reparent' = 'reject') {
    const access = await requireAccess(context);
    return await deleteWikiFolder(access, folderId, children);
  },

  // ─── Attachments ────────────────────────────────────────────────────────────
  // No DynamoDB record: the S3 object under the page's prefix is the whole
  // truth. Reading needs `read`, writing needs `write`, and the space is always
  // resolved from the page id — never taken from the caller. Uploads and
  // downloads go straight from the browser to S3 over a short-lived presigned
  // URL; the API only gates and signs, it never sees the bytes.

  /** A presigned URL to upload one attachment to a page. */
  async createAttachmentUploadUrl(input: {
    pageId: string;
    filename: string;
    contentType: string;
    size: number;
  }) {
    const access = await requireAccess(context);
    return await createUploadUrl(access, input);
  },

  /** The attachments on a page, newest first. */
  async listAttachments(pageId: string) {
    const access = await requireAccess(context);
    return await listPageAttachments(access, pageId);
  },

  /** A presigned URL to download one attachment. */
  async createAttachmentDownloadUrl(pageId: string, attachmentId: string) {
    const access = await requireAccess(context);
    return await createDownloadUrl(access, pageId, attachmentId);
  },

  /** Presigned URLs for several of a page's attachments at once. */
  async createAttachmentDownloadUrls(pageId: string, attachmentIds: string[]) {
    const access = await requireAccess(context);
    return await createDownloadUrls(access, pageId, attachmentIds);
  },

  /** Delete one attachment. Idempotent. */
  async deleteAttachment(pageId: string, attachmentId: string) {
    const access = await requireAccess(context);
    return await removeAttachment(access, pageId, attachmentId);
  },

  // ─── Reclamation (global administrators) ───────────────────────────────────
  // There is no periodic sweeper, by the same reasoning that applies to
  // orphaned permission records: a job that runs on a timer costs money forever
  // to catch a failure that is supposed to be rare. What replaces it is these
  // two endpoints — a job that exhausts its retries lands in the dead-letter
  // queue, but its reclamation record stays in DynamoDB, visible here.

  async listPendingCleanups(cursor?: string | null) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const pageSize = 100;
    const from = given(cursor);
    const items = await Array.fromAsync(
      table.query({
        where: {
          pk: { equals: CLEANUP_PK },
          ...(from === undefined ? {} : { sk: { greaterThan: from } }),
        },
        limit: pageSize,
      }),
    );
    const last = items.at(-1);
    return {
      items: items.map((item) => ({
        handle: item.sk,
        prefix: item.prefix ?? '',
        createdAt: item.createdAt,
      })),
      nextCursor: items.length === pageSize && last !== undefined ? last.sk : null,
    };
  },

  /** Re-submit one reclamation. The decision to retry is a person's. */
  async retryCleanup(handle: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    await requireItem(CLEANUP_PK, handle, 'Reclamation record');
    await reclaimJob.submit({ handles: [handle] });
    return { handle };
  },

  // ─── Grants (role group → space) ───────────────────────────────────────────
  // Global administrators only. A space administrator granting its own space to
  // an existing role group would widen that role group for everyone already in
  // it, which is not a decision the space owner can see the consequences of.

  async listSpaceRoleGroups(spaceId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const grants = await Array.fromAsync(
      table.query({ index: 'gsi1', where: { gsi1pk: { equals: spacePk(spaceId) } } }),
    );
    return grants.map((item) => ({
      roleGroupId: idOf(item.pk),
      permission: item.permission as Permission,
    }));
  },

  async grantSpaceToRoleGroup(spaceId: string, roleGroupId: string, permission: Permission) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    if (!PERMISSIONS.includes(permission)) invalid(`Unknown permission: ${permission}`);
    await requireItem(spacePk(spaceId), META, 'Space');
    await requireItem(roleGroupPk(roleGroupId), META, 'Role group');
    await table.put({
      pk: roleGroupPk(roleGroupId),
      sk: spacePk(spaceId),
      type: 'GRANT',
      gsi1pk: spacePk(spaceId),
      gsi1sk: roleGroupPk(roleGroupId),
      permission,
      addedAt: now(),
      addedBy: access.user.userSub,
    });
    await bumpEpoch();
    return { spaceId, roleGroupId, permission };
  },

  async revokeSpaceFromRoleGroup(spaceId: string, roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    await table.delete({ pk: roleGroupPk(roleGroupId), sk: spacePk(spaceId) });
    await bumpEpoch();
    return { spaceId, roleGroupId };
  },

  // ─── User groups ───────────────────────────────────────────────────────────

  async listUserGroups() {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const items = await Array.fromAsync(
      table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_USER_GROUPS } } }),
    );
    return items.map(asGroup);
  },

  async createUserGroup(input: { name: string; description?: string }) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const name = cleanName(input.name);
    const userGroupId = newId();
    await table.put(
      {
        pk: userGroupPk(userGroupId),
        sk: META,
        type: 'USER_GROUP',
        gsi1pk: ALL_USER_GROUPS,
        gsi1sk: sortable(name),
        name,
        description: cleanDescription(input.description ?? ''),
        createdAt: now(),
        version: 0,
      },
      { ifNotExists: true },
    );
    return { userGroupId };
  },

  /**
   * Removes the group, its memberships, and its role-group attachments.
   *
   * Deliberately tolerant of a missing group. The `gsi1` sweep below is
   * eventually consistent, so an edge written moments earlier can survive the
   * run that deleted the group. Re-invoking is how those get collected, and a
   * 404 on the second call would strand them for good.
   */
  async deleteUserGroup(userGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);

    const group = await table.get({ pk: userGroupPk(userGroupId), sk: META });
    if (group !== null) {
      if (group.system === true) forbidden('System user groups cannot be deleted');
      if ((await reachesGlobalAdmin(userGroupId)) && !(await adminsRemainWithout({ userGroupId }))) {
        forbidden('The last global administrator cannot be removed');
      }
      const defaults = await table.get({ pk: CONFIG_PK, sk: CONFIG_DEFAULTS });
      if (defaults?.defaultUserGroupId === userGroupId) {
        forbidden('Clear the default user group before deleting it');
      }
    }

    // Edges first, metadata last: the reverse order would leave edges that no
    // longer have a group to hang the guards off.
    await deleteByIndex(userGroupPk(userGroupId));
    // With the memberships, not after the whole delete: from here on the
    // permissions are gone from DynamoDB, and a failure in the steps below must
    // not leave every execution environment serving the old answer until the
    // backstop expires. The same reasoning as in `deleteSpace`.
    await bumpEpoch();
    const attachments = await Array.fromAsync(
      table.query({
        where: { pk: { equals: userGroupPk(userGroupId) }, sk: { beginsWith: 'RG#' } },
      }),
    );
    if (attachments.length > 0) {
      await table.deleteBatch(attachments.map((item) => ({ pk: item.pk, sk: item.sk })));
    }
    await table.delete({ pk: userGroupPk(userGroupId), sk: META });
    return { userGroupId };
  },

  async listUserGroupMembers(userGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const memberships = await Array.fromAsync(
      table.query({
        index: 'gsi1',
        where: { gsi1pk: { equals: userGroupPk(userGroupId) }, gsi1sk: { beginsWith: 'USER#' } },
      }),
    );
    const profiles = await table.getBatch(
      memberships.map((item) => ({ pk: item.pk, sk: PROFILE })),
    );
    return profiles.filter((item): item is Item => item !== null).map(asUser);
  },

  /**
   * The role groups attached to one user group — hop 2 of the traversal, read
   * back for the management screen.
   *
   * Ids only, matching `listSpaceRoleGroups` and `listRoleGroupGrants`. The
   * screen that shows this already holds the full role-group list, because the
   * "attach one" picker needs it, so returning names here would duplicate what
   * the caller has rather than save it a call.
   */
  async listUserGroupRoleGroups(userGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const attachments = await Array.fromAsync(
      table.query({
        where: { pk: { equals: userGroupPk(userGroupId) }, sk: { beginsWith: 'RG#' } },
      }),
    );
    return attachments.map((item) => ({ roleGroupId: idOf(item.sk) }));
  },

  async addUserToUserGroup(userGroupId: string, userId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    await requireItem(userGroupPk(userGroupId), META, 'User group');
    await requireItem(userPk(userId), PROFILE, 'User');
    await table.put({
      pk: userPk(userId),
      sk: userGroupPk(userGroupId),
      type: 'MEMBERSHIP',
      gsi1pk: userGroupPk(userGroupId),
      gsi1sk: userPk(userId),
      addedAt: now(),
      addedBy: access.user.userSub,
    });
    await bumpEpoch();
    return { userGroupId, userId };
  },

  async removeUserFromUserGroup(userGroupId: string, userId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);

    // Removing the last global administrator would leave nobody able to refill
    // the role, and the bootstrap claim is spent once it completes.
    const guarded = await reachesGlobalAdmin(userGroupId);
    if (guarded && !(await adminsRemainWithout({ userGroupId, userId }))) {
      forbidden('The last global administrator cannot be removed');
    }

    const membership = guarded
      ? await table.get({ pk: userPk(userId), sk: userGroupPk(userGroupId) })
      : null;
    await table.delete({ pk: userPk(userId), sk: userGroupPk(userGroupId) });
    await bumpEpoch();

    // Check-then-delete is not atomic, and DistributedTable has no multi-item
    // transaction. Two concurrent removals can both see two administrators and
    // both proceed, emptying the role. Counting again afterwards catches that,
    // and the membership is put back — an environment with no administrator has
    // no way back, because the bootstrap claim is spent.
    if (guarded && membership !== null && !(await anyGlobalAdminRemains())) {
      await table.put(membership, { ifNotExists: true }).catch(swallowConditionalFailure);
      // The restore is itself an edge write, so it moves the generation again.
      await bumpEpoch();
      conflict('That removal would have left no global administrator; it was undone');
    }
    return { userGroupId, userId };
  },

  // ─── Role groups ───────────────────────────────────────────────────────────

  async listRoleGroups() {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const items = await Array.fromAsync(
      table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_ROLE_GROUPS } } }),
    );
    return items.map(asGroup);
  },

  async createRoleGroup(input: { name: string; description?: string }) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const name = cleanName(input.name);
    const roleGroupId = newId();
    await table.put(
      {
        pk: roleGroupPk(roleGroupId),
        sk: META,
        type: 'ROLE_GROUP',
        gsi1pk: ALL_ROLE_GROUPS,
        gsi1sk: sortable(name),
        name,
        description: cleanDescription(input.description ?? ''),
        // `global` is set only by the bootstrap. Handing it out through the API
        // would make privilege escalation a single field away.
        global: false,
        createdAt: now(),
        version: 0,
      },
      { ifNotExists: true },
    );
    // Nothing reaches a role group the moment it is created — no attachment, no
    // grant, and `global: false` — so no stored answer can be wrong because of
    // it. The epoch moves anyway, because the rule was made "a permission
    // edge or a role group" precisely so that the decision never depends on
    // reasoning like the sentence above.
    await bumpEpoch();
    return { roleGroupId };
  },

  /**
   * Removes the role group, its grants, and its attachments to user groups.
   *
   * Tolerant of a missing role group for the same reason as `deleteUserGroup`:
   * re-invoking is what collects edges the eventually-consistent sweep missed.
   */
  async deleteRoleGroup(roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const group = await table.get({ pk: roleGroupPk(roleGroupId), sk: META });
    if (group?.system === true) forbidden('System role groups cannot be deleted');

    await deleteByIndex(roleGroupPk(roleGroupId));
    // As in `deleteUserGroup`: the attachments are already gone, so the epoch
    // moves before the steps that may fail, not after them.
    await bumpEpoch();
    const grants = await Array.fromAsync(
      table.query({
        where: { pk: { equals: roleGroupPk(roleGroupId) }, sk: { beginsWith: 'SPACE#' } },
      }),
    );
    if (grants.length > 0) {
      await table.deleteBatch(grants.map((item) => ({ pk: item.pk, sk: item.sk })));
    }
    await table.delete({ pk: roleGroupPk(roleGroupId), sk: META });
    return { roleGroupId };
  },

  async listRoleGroupGrants(roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const grants = await Array.fromAsync(
      table.query({
        where: { pk: { equals: roleGroupPk(roleGroupId) }, sk: { beginsWith: 'SPACE#' } },
      }),
    );
    return grants.map((item) => ({
      spaceId: idOf(item.sk),
      permission: item.permission as Permission,
    }));
  },

  /**
   * The user groups a role group is attached to — the same edge as
   * `listUserGroupRoleGroups`, read from the other end.
   *
   * The management screen shows it before a delete, so that removing a role
   * group is not a blind act: the edge is what carries the grants to people.
   * Served from `gsi1`, which is eventually consistent, so an attachment made
   * moments ago can be missing from this answer; the guards that refuse to empty
   * the administrator population are the ones that must not be wrong, and they
   * live in `adminsRemainWithout()`, not here.
   */
  async listRoleGroupUserGroups(roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const attachments = await Array.fromAsync(
      table.query({
        index: 'gsi1',
        where: { gsi1pk: { equals: roleGroupPk(roleGroupId) }, gsi1sk: { beginsWith: 'UG#' } },
      }),
    );
    return attachments.map((item) => ({ userGroupId: idOf(item.gsi1sk ?? '') }));
  },

  async attachRoleGroupToUserGroup(userGroupId: string, roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    await requireItem(userGroupPk(userGroupId), META, 'User group');
    await requireItem(roleGroupPk(roleGroupId), META, 'Role group');
    await table.put({
      pk: userGroupPk(userGroupId),
      sk: roleGroupPk(roleGroupId),
      type: 'ATTACHMENT',
      gsi1pk: roleGroupPk(roleGroupId),
      gsi1sk: userGroupPk(userGroupId),
      addedAt: now(),
      addedBy: access.user.userSub,
    });
    await bumpEpoch();
    return { userGroupId, roleGroupId };
  },

  async detachRoleGroupFromUserGroup(userGroupId: string, roleGroupId: string) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    if (
      userGroupId === SYSTEM_ADMIN_USER_GROUP &&
      roleGroupId === SYSTEM_ADMIN_ROLE_GROUP
    ) {
      forbidden('The administrator group cannot lose its role group');
    }
    // Cutting a different group off the global role group can empty the role
    // just as effectively, when that group held the only administrators left.
    if (roleGroupId === SYSTEM_ADMIN_ROLE_GROUP && !(await adminsRemainWithout({ userGroupId }))) {
      forbidden('The last global administrator cannot be removed');
    }
    await table.delete({ pk: userGroupPk(userGroupId), sk: roleGroupPk(roleGroupId) });
    await bumpEpoch();
    return { userGroupId, roleGroupId };
  },

  // ─── Directory and defaults ────────────────────────────────────────────────

  /**
   * Users known to the Wiki, for the "add a member" flow.
   *
   * Cognito owns the accounts but exposes no listing, so this returns only
   * accounts that have signed in at least once.
   *
   * This settles the paging contract that was left to the first listing API.
   * `query()` takes no start key, so paging is keyset: pass the `nextCursor`
   * from the previous page back as `cursor` and the scan resumes after it.
   * `nextCursor` is `null` on the last page — the caller is never left guessing
   * whether a result set was truncated, which a bare `limit` would do.
   */
  async findUsers(emailPrefix?: string | null, cursor?: string | null) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const pageSize = 50;
    const wanted = given(emailPrefix);
    const from = given(cursor);
    const prefix = wanted === undefined ? undefined : sortable(wanted);

    // `beginsWith` and `greaterThan` are both sort-key conditions and DynamoDB
    // takes only one, so a cursor-driven page filters the prefix in memory. The
    // over-read is bounded by one page.
    const items = await Array.fromAsync(
      table.query({
        index: 'gsi1',
        where: {
          gsi1pk: { equals: ALL_USERS },
          ...(from !== undefined
            ? { gsi1sk: { greaterThan: from } }
            : prefix !== undefined
              ? { gsi1sk: { beginsWith: prefix } }
              : {}),
        },
        limit: pageSize,
      }),
    );

    const page = from !== undefined && prefix !== undefined
      ? items.filter((item) => (item.gsi1sk ?? '').startsWith(prefix))
      : items;
    const last = items.at(-1);
    return {
      users: page.map(asUser),
      nextCursor: items.length === pageSize && last !== undefined ? (last.gsi1sk ?? null) : null,
    };
  },

  /**
   * The user group every account joins on first sign-in.
   *
   * Unset by default. Setting it turns "signed in" into a permission source,
   * which is how a Wiki-wide readable space is expressed.
   */
  async getDefaults() {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    const item = await table.get({ pk: CONFIG_PK, sk: CONFIG_DEFAULTS });
    return { defaultUserGroupId: item?.defaultUserGroupId ?? null, version: item?.version ?? 0 };
  },

  /**
   * Point the default user group somewhere, or clear it with `null`.
   *
   * The group must not confer global administrator. The default is joined
   * automatically on first sign-in, so pointing it at an administrative group
   * would quietly make every new account an administrator of the whole Wiki —
   * a setting meant to express "everyone can read this space" turning into
   * "everyone runs the place".
   *
   * Note this is not retroactive: it only affects accounts that sign in for the
   * first time afterwards.
   */
  async setDefaults(defaultUserGroupId: string | null, version: number) {
    const access = await requireAccess(context);
    requireGlobalAdmin(access);
    if (defaultUserGroupId !== null) {
      const group = await requireItem(userGroupPk(defaultUserGroupId), META, 'User group');
      if (group.system === true) invalid('A system user group cannot be the default');
      if (await reachesGlobalAdmin(defaultUserGroupId)) {
        invalid('A user group holding global administrator cannot be the default');
      }
    }

    const existing = await table.get({ pk: CONFIG_PK, sk: CONFIG_DEFAULTS });
    if ((existing?.version ?? 0) !== version) conflict('Defaults changed since they were read');
    await table
      .put(
        {
          pk: CONFIG_PK,
          sk: CONFIG_DEFAULTS,
          type: 'CONFIG',
          defaultUserGroupId: defaultUserGroupId ?? undefined,
          version: version + 1,
        },
        existing === null ? { ifNotExists: true } : { ifFieldEquals: { version } },
      )
      .catch(asConflict('Defaults'));
    return { defaultUserGroupId, version: version + 1 };
  },
}));

// Re-exported so pages, search, and the MCP server reuse the same gate rather
// than rebuilding one.
export { filterReadable, requireAccess, requireSpace, requireGlobalAdmin } from './access.js';

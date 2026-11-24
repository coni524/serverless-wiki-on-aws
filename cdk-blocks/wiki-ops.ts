/**
 * Page and search operations, expressed once for every caller.
 *
 * The Wiki's own logic has to sit where the UI-facing API, the AI assistant,
 * and the MCP server can all reach it. This module is that place, and it now
 * has four callers: `index.ts` (one thin ApiNamespace method per function),
 * `assistant.ts` (one agent tool per function), `mcp.ts` (one MCP tool per
 * function), and `ext.ts` (one `/ext/*` route per function).
 *
 * Every function takes a resolved `Access` rather than a request context, which
 * is what lets the same code run behind an HTTP request and inside the agent's
 * async job. Resolving it is the caller's job — `requireAccess(context)` on the
 * request path, `accessForUser(userSub)` in a tool — but *gating* is not: each
 * function below re-checks the space it is about to touch, so no caller can skip
 * the check by holding an `Access`.
 */
import { z } from 'zod';

import { keyOf, putItem, table, valuesOf } from './resources.js';
import {
  MAX_DEPTH,
  META,
  PAGE_REF_SK,
  PAGE_SK_PREFIX,
  type Item,
  idOf,
  kindOf,
  pageRefPk,
  pageSk,
  spacePk,
} from './model.js';
import {
  MAX_BODY_BYTES,
  ancestorsOf,
  asPage,
  childrenOf,
  collectSubtree,
  deletePageRecords,
  locatePage,
  pageReclaimPrefix,
  positionFor,
  promiseReclaim,
  readBody,
  readPage,
  requireCanHoldChildren,
  requireKind,
  requireNoCycle,
  siblingIndex,
  submitReclaim,
  subtreeHeight,
  writeBody,
} from './pages.js';
import { MAX_QUERY_CHARS, queryIndex, requestSync } from './search-index.js';
import { excerptOf, queryPhrases } from './search-excerpt.js';
import { type Viewing } from './viewing.js';
import {
  type Access,
  filterReadable,
  invalid,
  notFound,
  pageHasChildren,
  permissionOn,
  readableSpaces,
  requireSpace,
} from './access.js';

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// ─── Input cleaning ──────────────────────────────────────────────────────────
// Bounds are enforced here rather than at each caller, because a tool call is a
// caller too: the model composes the title and body, and nothing about it being
// a model makes the 200-character limit optional.

/**
 * Every character a one-line label must not carry.
 *
 * `\p{Cc}` is the Unicode Control category — CR and LF above all — and U+2028
 * and U+2029 are the two separators that end a line without being in it. A
 * title is a single line, and letting one break into two is what lets a stored
 * title reach places that read line by line: the assistant's screen block
 * closes its own end marker (`viewing.ts`), and an operator's terminal
 * interprets what follows an escape (`scripts/migrate-folders.ts`). Both of
 * those defend themselves too; this is the point where the character does not
 * enter the Wiki at all.
 *
 * Format characters (`\p{Cf}`) are deliberately allowed: U+200D joins the parts
 * of an emoji, and a title is welcome to hold one.
 */
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

/** Refuse a label that is not a single line, naming what it is for the caller. */
export function requireOneLine(value: string, what: string): void {
  if (NOT_ONE_LINE.test(value)) {
    invalid(`A ${what} may not contain a line break or a control character`);
  }
}

export function cleanTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') invalid('A title is required');
  if (trimmed.length > 200) invalid('A title may be at most 200 characters');
  requireOneLine(trimmed, 'title');
  return trimmed;
}

/** The body goes to S3, so the only bound worth enforcing is a sanity one. */
export function cleanBody(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) {
    invalid(`A page body may be at most ${MAX_BODY_BYTES / 1024} KiB`);
  }
  return value;
}

async function requireSpaceExists(spaceId: string): Promise<Item> {
  const item = await table.get({ pk: spacePk(spaceId), sk: META });
  if (item === null) notFound('Space not found');
  return item;
}

// ─── Search ──────────────────────────────────────────────────────────────────────
// One query to the S3 Vectors index answers both the meaning and the words
// (see `search-index.ts`); these turn its hits into the pages a caller may read.

/**
 * The spaces a search is narrowed to, or `undefined` for every space.
 *
 * With a space named, that space alone, and only after `read` on it is
 * required. Without one, the spaces the caller holds a grant on — or every
 * space for a global administrator, who reaches them all. This narrows the
 * search; `filterReadable` on the result set is still what authorizes what
 * comes back.
 */
function searchScope(access: Access, spaceId?: string): string[] | undefined {
  if (spaceId !== undefined) {
    requireSpace(access, spaceId, 'read');
    return [spaceId];
  }
  return access.isGlobalAdmin ? undefined : [...access.spaces.keys()];
}

/**
 * Keep the hits the caller may read and whose page still exists, attach the
 * live title and the space name, and cut to `limit`.
 *
 * `filterReadable` is the single permission gate for a multi-space result set —
 * the index's space filter is only a narrowing. A hit whose page was deleted
 * but whose vectors are not yet removed is dropped here.
 */
async function toPages<T extends { spaceId: string; pageId: string }>(
  access: Access,
  hits: T[],
  limit: number,
) {
  const readable = filterReadable(access, hits);
  const metas = await table.getBatch(
    readable.map((hit) => ({ pk: spacePk(hit.spaceId), sk: pageSk(hit.pageId) })),
  );
  const pages = readable
    .map((hit, index) => ({ hit, meta: metas[index] }))
    .filter((row) => row.meta !== null && row.meta !== undefined && row.meta.type === 'PAGE')
    .slice(0, limit);

  const spaceIds = [...new Set(pages.map((row) => row.hit.spaceId))];
  const spaceMetas = await table.getBatch(spaceIds.map((id) => ({ pk: spacePk(id), sk: META })));
  const names = new Map<string, string>();
  spaceIds.forEach((id, index) => names.set(id, spaceMetas[index]?.name ?? ''));

  return pages.map((row) => ({
    hit: row.hit,
    meta: row.meta!,
    spaceName: names.get(row.hit.spaceId) ?? '',
  }));
}

/**
 * The search query as a tool takes it: text no longer than the index accepts.
 *
 * The MCP server's and the assistant's `searchWiki` tools both declare it, so an
 * over-long query is refused with a validation error before any work is done,
 * and the bound shows in the JSON Schema the model reads.
 */
export const searchQuerySchema = z.string().max(MAX_QUERY_CHARS);

/**
 * The query argument of a search call, refused unless it is text.
 *
 * The UI's API methods receive their arguments as parsed JSON, so the declared
 * `string` is not enforced at run time; a number or an object would otherwise
 * fail on `trim()` as a server error rather than as the caller's mistake.
 */
function queryText(query: unknown): string {
  if (typeof query !== 'string') invalid('The search query must be a string');
  return query;
}

/**
 * How many hits a search call asks for, floored and clamped into `[1, max]`.
 *
 * Left out — `undefined`, or the `null` JSON carries for an argument skipped
 * before a supplied one — it is `fallback`. Anything that is not a finite
 * number is refused as invalid input: the UI's API methods receive parsed JSON
 * with no run-time type check, and a string or `NaN` would otherwise survive
 * the clamp as `NaN` and reach the index as its `topK`.
 */
export function hitLimit(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) invalid('limit must be a finite number');
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

/**
 * The query one search request works with, and the phrases its excerpts look for.
 *
 * The text is cut to what the index accepts before anything else sees it. The
 * index would cut it anyway, but the excerpts are built from the query too, and
 * their cost grows with the query's length on every hit; an uncut query of a
 * few megabytes can keep the Lambda busy for seconds per request while asking
 * the index no more than its first 1,024 characters do. Cutting here covers every
 * caller, since the UI, the assistant and the MCP server all search through
 * `searchPages`. The phrases are split once here rather than once per hit.
 */
export function searchTerms(query: unknown): { text: string; phrases: string[] } {
  const text = queryText(query).trim().slice(0, MAX_QUERY_CHARS);
  return { text, phrases: queryPhrases(text) };
}

/**
 * Search over page text — by meaning and by words, in one ranking.
 *
 * The index runs both searches and fuses them into one ranking, which the
 * returned order follows. No score is returned: the fused value follows from
 * the rank alone and no caller needs it. With `spaceId`, the search is
 * confined to one space: the caller
 * must hold `read` on it. Without it, the search is narrowed to the caller's
 * spaces (see `searchScope`). Every hit passes through
 * `filterReadable` before it is returned, which holds for the assistant's and
 * the MCP server's search tools too, because they come through here.
 */
export async function searchPages(
  access: Access,
  query: string,
  options?: { spaceId?: string; limit?: number },
) {
  const { text: q, phrases } = searchTerms(query);
  if (q === '') return { items: [] };
  const limit = hitLimit(options?.limit, 10, 50);

  const spaceIds = searchScope(access, options?.spaceId);
  // Over-fetch: chunks collapse to pages and the permission gate thins them.
  const hits = await queryIndex(q, {
    ...(spaceIds === undefined ? {} : { spaceIds }),
    topK: Math.min(100, limit * 4),
    vector: true,
  });

  const pages = await toPages(access, hits, limit);
  return {
    items: pages.map(({ hit, meta, spaceName }) => {
      // The excerpt is cut around the query's words when the full-text search
      // matched, so the screen can embolden them; otherwise it is the head of
      // the matching chunk.
      const excerpt = excerptOf(hit.text, phrases);
      const useExcerpt = hit.matchedText && excerpt.highlights.length > 0;
      return {
        pageId: hit.pageId,
        spaceId: hit.spaceId,
        spaceName,
        title: meta.title ?? '',
        snippet: useExcerpt ? excerpt.snippet : excerptOf(hit.text, []).snippet,
        highlights: useExcerpt ? excerpt.highlights : [],
      };
    }),
  };
}

/**
 * Suggestions for a query still being typed.
 *
 * The full-text search alone: no embedding means no Bedrock call, which keeps
 * this cheap enough for every keystroke. It matches whole words, so a word
 * still being typed suggests nothing until it is complete. Same permission
 * gate as `searchPages`.
 */
export async function suggestPages(
  access: Access,
  query: string,
  options?: { spaceId?: string; limit?: number },
) {
  // Cut the same way `searchPages` cuts; the index would cut it anyway.
  const q = queryText(query).trim().slice(0, MAX_QUERY_CHARS);
  if (q === '') return { items: [] };
  const limit = hitLimit(options?.limit, 7, 20);

  const spaceIds = searchScope(access, options?.spaceId);
  const hits = await queryIndex(q, {
    ...(spaceIds === undefined ? {} : { spaceIds }),
    topK: limit * 4,
    vector: false,
  });

  const pages = await toPages(access, hits, limit);
  return {
    items: pages.map(({ hit, meta, spaceName }) => ({
      pageId: hit.pageId,
      spaceId: hit.spaceId,
      title: meta.title ?? '',
      kind: meta.kind ?? 'page',
      spaceName,
    })),
  };
}

// ─── Pages ───────────────────────────────────────────────────────────────────────
// Reading needs `read` on the space, writing needs `write`. The space is always
// resolved from the page id through the locator record — never taken from the
// caller, which would let someone with access to one space name another space's
// page. That matters twice over for a tool call, where the page id may have been
// produced by the model.

/**
 * The spaces this caller may read, with the permission held on each, by name.
 *
 * Every surface that shows a user "what can I reach" answers with this: the UI's
 * space list, the MCP `listSpaces` tool, and `/ext/listSpaces`. They differ only
 * in which fields they pass on, so the traversal, the permission resolution and
 * the ordering are settled once here.
 *
 * `readableSpaces` is the permission filter, so nothing the caller cannot read
 * is in the list to begin with. `permission` is therefore always one of the
 * three; it is left undefined rather than defaulted if it somehow is not,
 * because a default would report a grant the walk did not find.
 */
export async function mySpaces(access: Access) {
  const spaces = await readableSpaces(access);
  return spaces
    .map((item) => ({
      spaceId: idOf(item.pk),
      name: item.name ?? '',
      description: item.description ?? '',
      createdAt: item.createdAt,
      version: item.version ?? 0,
      permission: permissionOn(access, idOf(item.pk)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An omitted cursor, whatever the caller spelled it as.
 *
 * An argument the caller left out arrives as `null` rather than `undefined`
 * when it sits before one that was supplied, because that is what JSON carries;
 * an empty form field arrives as `''`. Neither is a cursor. Reading one as a
 * cursor asks for the rows after it and finds none, so a first page comes back
 * empty and the caller sees "there is nothing here" instead of a mistake.
 */
const givenCursor = (value: string | null | undefined): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : value;

/**
 * Every page in a space, in key order, one page of results at a time.
 *
 * Served from the primary key rather than an index, because this listing is
 * the one that must not miss a row: reindexing, export, the metadata half of a
 * space delete, and a sync client's whole-space snapshot all ride on
 * it, and `gsi1` is only eventually consistent.
 *
 * Keyset paging, per the contract `findUsers()` settled: pass the previous
 * `nextCursor` back, and `null` means this was the last page.
 */
export async function listPages(access: Access, spaceId: string, cursor?: string | null) {
  requireSpace(access, spaceId, 'read');
  const pageSize = 100;
  const from = givenCursor(cursor);
  const items = await valuesOf(
    table.query({
      where: {
        pk: { equals: spacePk(spaceId) },
        ...(from === undefined
          ? { sk: { beginsWith: PAGE_SK_PREFIX } }
          : { sk: { greaterThan: from } }),
      },
      limit: pageSize,
    }),
  );
  // A cursor-driven page cannot also carry the `beginsWith`, so the filter
  // moves in-memory. `META` sorts before `PAGE#`, so the only thing this ever
  // drops is a non-page item on the first page after the cursor overshoots.
  const pages = items.filter((item) => item.type === 'PAGE');
  const last = items.at(-1);
  return {
    items: pages.map(asPage),
    nextCursor: items.length === pageSize && last !== undefined ? last.sk : null,
  };
}

/**
 * The direct children of a page, or of the space root when `parentPageId` is
 * null — the query a tree view expands one node at a time.
 *
 * The parent's space is taken from the parent itself, not from the caller, so a
 * caller holding a page id cannot name a space they have no business naming.
 * That matters twice over here: both the AI assistant and the MCP server reach
 * this with ids the model produced.
 *
 * Keyset paging, per the contract `findUsers()` settled: pass the previous
 * `nextCursor` back, and `null` means this was the last page.
 *
 * Each child comes back with `hasChildren`, which is what lets the tree view
 * show an expand arrow only on the pages that have something under them. The
 * page item does not carry a child count — nothing maintains one, and keeping
 * one correct across create, delete, and reparent would put a write on the
 * parent of every write — so the answer is one `limit: 1` query per child,
 * against the same index the level itself came from. They run together, so the
 * level costs one extra round trip and one extra small read per child.
 */
export async function listChildPages(
  access: Access,
  spaceId: string,
  parentPageId: string | null,
  cursor?: string | null,
) {
  if (parentPageId !== null) {
    const owner = await locatePage(parentPageId);
    if (owner !== spaceId) notFound('Page not found');
    requireSpace(access, owner, 'read', 'Page');
    await readPage(owner, parentPageId);
  } else {
    requireSpace(access, spaceId, 'read');
  }
  const pageSize = 100;
  // An omitted cursor arrives as `null` or `''` depending on the caller; neither
  // is a cursor. Reading one as a cursor asks for the rows after it and finds
  // none, so a first page comes back empty (see `given` in `index.ts`).
  const from = cursor === undefined || cursor === null || cursor === '' ? undefined : cursor;
  const children = await childrenOf(spaceId, parentPageId ?? undefined, {
    limit: pageSize,
    ...(from === undefined ? {} : { cursor: from }),
  });
  // The index is keyed by parent alone, so pages of another space could only
  // appear if a cross-space move existed. It does not, and the
  // filter keeps that assumption from becoming an unchecked one.
  const last = children.at(-1);
  const items = children
    .filter((item) => item.type === 'PAGE' && idOf(item.pk) === spaceId)
    .map(asPage);
  // Only a folder can hold children, so only a folder is asked. A
  // level of plain pages now costs no extra reads at all.
  const grandchildren = await Promise.all(
    items.map((item) =>
      item.kind === 'folder' ? childrenOf(spaceId, item.pageId, { limit: 1 }) : Promise.resolve([]),
    ),
  );
  return {
    items: items.map((item, index) => ({
      ...item,
      hasChildren: grandchildren[index].length > 0,
    })),
    nextCursor: children.length === pageSize && last?.gsi1sk !== undefined ? last.gsi1sk : null,
  };
}

/**
 * How a client names the body it already holds.
 *
 * The revision alone will not do. It counts body writes and is assigned as
 * `current + 1`, so two writers saving from the same revision both land on the
 * next number while their bodies differ — the loser's client would hold one of
 * them and go on believing it current. `updatedAt` is written on every metadata
 * write and separates them.
 */
export const bodyStamp = (page: { revision: number; updatedAt?: string }) =>
  `${page.revision}@${page.updatedAt ?? ''}`;

export type PageDetail = ReturnType<typeof asPage> & {
  /** Absent only when the caller's stamp still matched, i.e. `unchanged`. */
  body?: string;
  unchanged: boolean;
  // `kind` is here because the ancestors of a node are not all one kind. After
  // the folder migration every ancestor is a folder, but a tree that has not
  // been migrated still holds child-bearing pages — and a client that guessed
  // would link half of them at the wrong screen.
  breadcrumb: { pageId: string; title: string; kind: 'page' | 'folder' }[];
};

/**
 * A page with its body and its breadcrumb.
 *
 * `knownStamp` is what the caller already has. When it still matches, the body
 * is not read from S3 and not sent; `unchanged` says so. Callers that omit the
 * argument — the assistant's `readPage` tool and the MCP server — always get the
 * body, and the overloads say so in the type: only the stamped call has to deal
 * with an absent body.
 *
 * The breadcrumb is always resolved. An ancestor's title changes without moving
 * this page's stamp, so a cached breadcrumb would go stale invisibly.
 */
export async function readPageDetail(
  access: Access,
  pageId: string,
): Promise<PageDetail & { body: string }>;
export async function readPageDetail(
  access: Access,
  pageId: string,
  knownStamp: string | null | undefined,
): Promise<PageDetail>;
export async function readPageDetail(
  access: Access,
  pageId: string,
  knownStamp?: string | null,
): Promise<PageDetail> {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'read', 'Page');
  const page = await readPage(spaceId, pageId);
  // A folder has no body, and handing back an empty one would let a caller edit
  // and save it as if it were a page. `getFolder` answers for that kind.
  requireKind(page, 'page');

  const summary = asPage(page);
  const current = bodyStamp(summary);
  const unchanged =
    knownStamp !== undefined && knownStamp !== null && knownStamp !== '' && knownStamp === current;

  const [body, ancestors] = await Promise.all([
    unchanged ? Promise.resolve(undefined) : readBody(page.bodyKey),
    ancestorsOf(spaceId, page),
  ]);
  return {
    ...summary,
    body,
    unchanged,
    breadcrumb: ancestors.map((item) => ({
      pageId: idOf(item.sk),
      title: item.title ?? '',
      kind: kindOf(item),
    })),
  };
}

// ─── What the user is looking at ─────────────────────────────────────────────────

/**
 * The screen a client says its user has open, before anything has been checked.
 *
 * The client is the only thing that knows this, so it is the client that says
 * it — and a claim from a client is an input like any other. Both ids are
 * optional because the user may be on a space with no page open, or on a screen
 * that is neither.
 */
export type ViewingClaim = { spaceId?: string | null; pageId?: string | null };

/**
 * Resolve the screen claim into names the assistant can act on, or nothing.
 *
 * The claim only chooses which page to look up; it grants nothing. The space
 * still goes through `requireSpace`, so a user who names a page they cannot read
 * gets the same "not found" they would get from `readPage`, and a claim naming a
 * page in another space fails on the partition it is read from.
 *
 * A claim that resolves to nothing is dropped rather than raised. This runs on
 * the way to the assistant, and a stale id in a tab left open overnight should
 * cost the user the screen context, not the ability to ask a question.
 *
 * The body is deliberately not read. It can be hundreds of KiB and would be
 * resent with every message; the assistant reads it with `readPage` on the turns
 * that actually need it.
 */
export async function resolveViewing(
  access: Access,
  claim: ViewingClaim | undefined,
): Promise<Viewing | null> {
  const spaceId = typeof claim?.spaceId === 'string' ? claim.spaceId : '';
  const pageId = typeof claim?.pageId === 'string' ? claim.pageId : '';
  if (spaceId === '') return null;
  try {
    requireSpace(access, spaceId, 'read');
    const space = await requireSpaceExists(spaceId);
    const spaceName = typeof space.name === 'string' ? space.name : '';
    if (pageId === '') return { spaceId, spaceName };
    try {
      const page = await readPage(spaceId, pageId);
      return {
        spaceId,
        spaceName,
        page: { pageId, title: typeof page.title === 'string' ? page.title : '' },
      };
    } catch {
      // The page is gone, or was never in this space. The space it was named
      // under still resolved, and is worth keeping: a user whose page was just
      // deleted can still say "create it again in this space".
      return { spaceId, spaceName };
    }
  } catch {
    return null;
  }
}

/**
 * Create a page, optionally under a parent, at the end of its siblings.
 *
 * The body reaches S3 before either record is written, so a failure part-way
 * leaves an unreferenced object rather than a page whose body is missing:
 * unreachable bytes cost storage, a dangling reference shows the reader a
 * broken page.
 */
export async function createPage(
  access: Access,
  input: { spaceId: string; parentPageId?: string | null; title: string; body?: string },
) {
  requireSpace(access, input.spaceId, 'write');
  // A global administrator holds `admin` on every space id, existing or not,
  // so the gate alone would happily create a page in a space that was deleted
  // — writing its body under a prefix a reclamation job may be sweeping.
  await requireSpaceExists(input.spaceId);
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body ?? '');

  const parentPageId = input.parentPageId ?? undefined;
  if (parentPageId !== undefined) {
    const parent = await readPage(input.spaceId, parentPageId);
    requireCanHoldChildren(parent);
    const depth = (await ancestorsOf(input.spaceId, parent)).length + 1;
    if (depth + 1 > MAX_DEPTH) {
      invalid(`A page may not sit deeper than ${MAX_DEPTH} levels`);
    }
  }

  const pageId = newId();
  const stamp = now();
  const key = await writeBody(input.spaceId, pageId, 1, body);
  const position = await positionFor(input.spaceId, parentPageId, undefined);

  await putItem({
    pk: pageRefPk(pageId),
    sk: PAGE_REF_SK,
    type: 'PAGE_REF',
    spaceId: input.spaceId,
    createdAt: stamp,
  });
  await putItem({
    pk: spacePk(input.spaceId),
    sk: pageSk(pageId),
    type: 'PAGE',
    kind: 'page',
    ...siblingIndex(input.spaceId, parentPageId, position, pageId),
    title,
    ...(parentPageId === undefined ? {} : { parentPageId }),
    position,
    bodyKey: key,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    createdBy: access.user.userSub,
    updatedBy: access.user.userSub,
  });

  // Feed the page to search. Best-effort: the page is already persisted, and a
  // derived index must not fail the save (see `requestSync`).
  await requestSync([{ spaceId: input.spaceId, pageId }]);

  return { pageId, spaceId: input.spaceId, revision: 1 };
}

/**
 * Save a new title, a new body, or both.
 *
 * There is no `version` and no 409. Whoever saves last wins, and the loser's
 * text survives as its own revision rather than being overwritten. Pages are
 * deliberately unlike the permission entities here: a rename collision
 * between two administrators is worth reporting, while a text collision is
 * something collaborative editing will resolve properly, and a conflict
 * dialog built now would be thrown away then.
 */
export async function updatePage(
  access: Access,
  pageId: string,
  patch: { title?: string; body?: string },
) {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'write', 'Page');
  const page = await readPage(spaceId, pageId);
  // A folder has no body to save and no revision to advance; renaming one goes
  // through `renameFolder`.
  requireKind(page, 'page');

  const title = patch.title === undefined ? (page.title ?? '') : cleanTitle(patch.title);
  // The revision counts body writes, because it is part of the body's key. A
  // rename alone leaves the current revision exactly where it is.
  const revision = patch.body === undefined ? (page.revision ?? 1) : (page.revision ?? 1) + 1;
  const key =
    patch.body === undefined
      ? page.bodyKey
      : await writeBody(spaceId, pageId, revision, cleanBody(patch.body));

  // Held rather than written inline, because it is half of the stamp
  // (`bodyStamp`) and the answer carries it: a client that has just saved knows
  // the body it sent is the current one only if it is told the stamp that body
  // was written under.
  const updatedAt = now();

  await putItem({
    pk: page.pk,
    sk: page.sk,
    type: 'PAGE',
    kind: 'page',
    ...siblingIndex(spaceId, page.parentPageId, page.position ?? '', pageId),
    title,
    ...(page.parentPageId === undefined ? {} : { parentPageId: page.parentPageId }),
    position: page.position,
    bodyKey: key,
    revision,
    createdAt: page.createdAt,
    updatedAt,
    createdBy: page.createdBy,
    updatedBy: access.user.userSub,
  });

  // Re-index: a rename changes the indexed text as much as a body edit does.
  // Best-effort — see `requestSync`.
  await requestSync([{ spaceId, pageId }]);

  return { pageId, title, revision, updatedAt };
}

/**
 * Reparent a page, reorder it among its siblings, or both.
 *
 * One item is written, however large the subtree: the descendants keep pointing
 * at their own parents, and nothing stores a path that would have to follow.
 * `afterPageId` names the sibling to land behind — `null` for first, omitted
 * for last.
 *
 * Moving between spaces is not offered. It would change the partition key,
 * relocate the S3 objects, and rewrite the locator record, with no way to make
 * the three agree if the call died in the middle.
 */
export async function movePage(
  access: Access,
  pageId: string,
  target: { parentPageId?: string | null; afterPageId?: string | null },
) {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'write', 'Page');
  const page = await readPage(spaceId, pageId);

  const newParentId =
    target.parentPageId === undefined ? page.parentPageId : (target.parentPageId ?? undefined);

  if (newParentId !== undefined && newParentId !== page.parentPageId) {
    if (newParentId === pageId) invalid('A page cannot be its own parent');
    const parent = await readPage(spaceId, newParentId);
    requireCanHoldChildren(parent);
    await requireNoCycle(spaceId, pageId, newParentId);
    const parentDepth = (await ancestorsOf(spaceId, parent)).length + 1;
    const height = await subtreeHeight(spaceId, pageId, MAX_DEPTH - parentDepth);
    if (parentDepth + height > MAX_DEPTH) {
      invalid(`That move would push the tree past ${MAX_DEPTH} levels`);
    }
  }

  const position = await positionFor(spaceId, newParentId, target.afterPageId, pageId);
  await putItem({
    pk: page.pk,
    sk: page.sk,
    type: 'PAGE',
    // Either kind moves through here: a move writes the edge and the position,
    // and a folder carries the same two.
    kind: kindOf(page),
    ...siblingIndex(spaceId, newParentId, position, pageId),
    title: page.title,
    ...(newParentId === undefined ? {} : { parentPageId: newParentId }),
    position,
    // Written only when there is one. A folder has neither, and the block
    // marshals items without `removeUndefinedValues`, so an explicit `undefined`
    // is rejected on AWS while passing against the local mock.
    ...(page.bodyKey === undefined ? {} : { bodyKey: page.bodyKey }),
    ...(page.revision === undefined ? {} : { revision: page.revision }),
    createdAt: page.createdAt,
    updatedAt: now(),
    createdBy: page.createdBy,
    updatedBy: access.user.userSub,
  });
  return { pageId, parentPageId: newParentId ?? null, position };
}

// ─── Folders ─────────────────────────────────────────────────────────────────────
// A folder is a node with a name, a parent, and a place among its siblings, and
// nothing else: no body in S3, no attachments, no search document. It is the
// only kind that may hold children, which is what makes the Wiki's tree and an
// Obsidian vault's tree the same shape.

/**
 * Create a folder, at the end of its siblings.
 *
 * There is no body to write first, so this is two writes: the locator, then the
 * node. The order is the one every create follows — a locator resolving to
 * nothing is a 404, while a node no id can be turned back into is unreachable.
 */
export async function createFolder(
  access: Access,
  input: { spaceId: string; parentPageId?: string | null; title: string },
) {
  requireSpace(access, input.spaceId, 'write');
  await requireSpaceExists(input.spaceId);
  const title = cleanTitle(input.title);

  const parentPageId = input.parentPageId ?? undefined;
  if (parentPageId !== undefined) {
    const parent = await readPage(input.spaceId, parentPageId);
    requireCanHoldChildren(parent);
    const depth = (await ancestorsOf(input.spaceId, parent)).length + 1;
    if (depth + 1 > MAX_DEPTH) {
      invalid(`A folder may not sit deeper than ${MAX_DEPTH} levels`);
    }
  }

  const folderId = newId();
  const stamp = now();
  const position = await positionFor(input.spaceId, parentPageId, undefined);

  await putItem({
    pk: pageRefPk(folderId),
    sk: PAGE_REF_SK,
    type: 'PAGE_REF',
    spaceId: input.spaceId,
    createdAt: stamp,
  });
  await putItem({
    pk: spacePk(input.spaceId),
    sk: pageSk(folderId),
    type: 'PAGE',
    kind: 'folder',
    ...siblingIndex(input.spaceId, parentPageId, position, folderId),
    title,
    ...(parentPageId === undefined ? {} : { parentPageId }),
    position,
    createdAt: stamp,
    updatedAt: stamp,
    createdBy: access.user.userSub,
    updatedBy: access.user.userSub,
  });

  return { folderId, spaceId: input.spaceId };
}

/** Rename a folder. The only thing about a folder there is to edit. */
export async function renameFolder(access: Access, folderId: string, title: string) {
  const spaceId = await locatePage(folderId);
  requireSpace(access, spaceId, 'write', 'Folder');
  const folder = await readPage(spaceId, folderId);
  requireKind(folder, 'folder');
  const name = cleanTitle(title);

  await putItem({
    pk: folder.pk,
    sk: folder.sk,
    type: 'PAGE',
    kind: 'folder',
    ...siblingIndex(spaceId, folder.parentPageId, folder.position ?? '', folderId),
    title: name,
    ...(folder.parentPageId === undefined ? {} : { parentPageId: folder.parentPageId }),
    position: folder.position,
    createdAt: folder.createdAt,
    updatedAt: now(),
    createdBy: folder.createdBy,
    updatedBy: access.user.userSub,
  });

  return { folderId, title: name };
}

/**
 * A folder's name and breadcrumb, for a client that was handed the id alone.
 *
 * `getPage` cannot answer this: it reads a body, and refuses a folder outright.
 * The children are not included — a folder's contents are a listing with its own
 * paging (`listChildPages`), and folding one page of it into this call would
 * make the first page look like the whole.
 */
export async function readFolderDetail(access: Access, folderId: string) {
  const spaceId = await locatePage(folderId);
  requireSpace(access, spaceId, 'read', 'Folder');
  const folder = await readPage(spaceId, folderId);
  requireKind(folder, 'folder');
  const ancestors = await ancestorsOf(spaceId, folder);
  return {
    ...asPage(folder),
    breadcrumb: ancestors.map((item) => ({
      pageId: idOf(item.sk),
      title: item.title ?? '',
      kind: kindOf(item),
    })),
  };
}

/**
 * Delete a page.
 *
 * `children` is kept even though a page may no longer hold any:
 * pages created before folders existed can still have them until the migration
 * has run, and refusing to delete such a page without saying why would be worse
 * than carrying an argument that is usually irrelevant.
 */
export async function deletePage(
  access: Access,
  pageId: string,
  children: 'reject' | 'cascade' | 'reparent' = 'reject',
) {
  return await deleteNode(access, pageId, 'page', children);
}

/**
 * Delete a folder, and say what becomes of what is inside it.
 *
 * The three choices are the ones `deletePage` already offered, for the same
 * reason: cascading would delete nodes nobody asked about, and reparenting would
 * reshape the tree behind the caller's back, so neither is safe as a default.
 */
export async function deleteFolder(
  access: Access,
  folderId: string,
  children: 'reject' | 'cascade' | 'reparent' = 'reject',
) {
  return await deleteNode(access, folderId, 'folder', children);
}

/**
 * The delete both kinds share.
 *
 * Only the pages among the doomed nodes reach S3 and the search index. A folder
 * never wrote either, so promising to reclaim its prefix would file a cleanup
 * record against an empty sweep, and unindexing it would name vectors that were
 * never written.
 */
async function deleteNode(
  access: Access,
  nodeId: string,
  kind: 'page' | 'folder',
  children: 'reject' | 'cascade' | 'reparent',
) {
  const label = kind === 'folder' ? 'Folder' : 'Page';
  const spaceId = await locatePage(nodeId);
  requireSpace(access, spaceId, 'write', label);
  const node = await readPage(spaceId, nodeId);
  requireKind(node, kind);
  const direct = await childrenOf(spaceId, nodeId);

  if (children === 'reject' && direct.length > 0) {
    pageHasChildren(direct.length);
  }

  if (children === 'reparent' && direct.length > 0) {
    // Lifted to the deleted node's own parent, keeping their positions. The
    // positions came from a different sibling list, so the order among the
    // newly promoted nodes is preserved but their placement among their new
    // siblings is arbitrary.
    //
    // Composed field by field rather than spread over the stored child. A
    // spread would have to blank `parentPageId` with an explicit `undefined`
    // when the promotion is to the top level, and the block marshals items
    // without `removeUndefinedValues`, so that write is rejected on AWS while
    // passing against the local mock. The body fields are written the same way,
    // since a promoted folder has neither.
    await table.putBatch(
      direct.map((child) => ({
        pk: child.pk,
        sk: child.sk,
        type: 'PAGE' as const,
        kind: kindOf(child),
        ...siblingIndex(spaceId, node.parentPageId, child.position ?? '', idOf(child.sk)),
        title: child.title,
        ...(node.parentPageId === undefined ? {} : { parentPageId: node.parentPageId }),
        position: child.position,
        ...(child.bodyKey === undefined ? {} : { bodyKey: child.bodyKey }),
        ...(child.revision === undefined ? {} : { revision: child.revision }),
        createdAt: child.createdAt,
        updatedAt: now(),
        createdBy: child.createdBy,
        updatedBy: access.user.userSub,
      })).map((value) => ({ key: keyOf(value), value })),
    );
  }

  const doomed = children === 'cascade' ? await collectSubtree(spaceId, node) : [node];
  const doomedPages = doomed.filter((item) => kindOf(item) === 'page');
  // Promise, delete, then reclaim — never reclaim before the records are
  // gone, or the job can empty a page that is still readable.
  const reclaiming = await promiseReclaim(
    doomedPages.map((item) => pageReclaimPrefix(spaceId, idOf(item.sk))),
  );

  await deletePageRecords(doomed);
  await submitReclaim(reclaiming);

  // Drop the deleted pages from search. After the records are gone, because the
  // job reads the page as it stands and removes its vectors only when it finds
  // the page missing. Reparented children keep theirs; their text did not
  // change. Best-effort.
  await requestSync(doomedPages.map((item) => ({ spaceId, pageId: idOf(item.sk) })));

  return { pageId: nodeId, deleted: doomed.length };
}

/**
 * Page storage — keys, tree walks, body writes, and reclamation.
 *
 * The tree is nothing but a parent reference per page. There is no denormalized
 * path, because moving a subtree would then rewrite every descendant, and
 * DistributedTable has no multi-item transaction: a half-finished move would
 * leave part of the tree pointing at a path that no longer lists. Walking to
 * the root instead costs one `get()` per level, and the depth cap bounds it.
 *
 * Nothing here decides permissions. Every caller resolves the space first and
 * gates on it — see `access.ts`.
 */
import { content, table } from './resources.js';
import { reclaimJob } from './reclaim.js';
import {
  CLEANUP_PK,
  MAX_DEPTH,
  PAGE_REF_SK,
  PAGE_SK_PREFIX,
  after,
  between,
  bodyKey,
  childrenOfPage,
  cleanupSk,
  idOf,
  kindOf,
  pagePrefix,
  pageRefPk,
  pageSk,
  parentKey,
  siblingSk,
  spacePk,
  spacePrefix,
  type Item,
} from './model.js';
import { invalid, notFound } from './access.js';

/** Ceiling on a single cascading delete, so the API call stays bounded. */
export const CASCADE_LIMIT = 500;

/** Bodies live in S3; a page item only ever carries the key of the current one. */
export const MAX_BODY_BYTES = 1024 * 1024;

export const asPage = (item: Item) => ({
  pageId: idOf(item.sk),
  spaceId: idOf(item.pk),
  kind: kindOf(item),
  parentPageId: item.parentPageId ?? null,
  title: item.title ?? '',
  position: item.position ?? '',
  revision: item.revision ?? 1,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  createdBy: item.createdBy,
  updatedBy: item.updatedBy,
});

/**
 * The one invariant folders introduce: only a folder may be a parent.
 *
 * Checked wherever a parent is named — creating a node under it, or moving one
 * into it. Nothing repairs a violation after the fact, because the tree has no
 * other record of who may hold children: the edge lives on the child, and a page
 * that acquired one would list as an ordinary child in `gsi1` and mirror into
 * the vault as a note holding notes, which the filesystem cannot represent.
 */
export function requireCanHoldChildren(parent: Item): void {
  if (kindOf(parent) !== 'folder') {
    invalid('A page cannot hold children; name a folder as the parent');
  }
}

/**
 * Refuse an id that names the other kind of node.
 *
 * Reported as "not found" rather than as a bad request, which is what `readPage`
 * already does for an id belonging to some other entity: the two kinds share one
 * id space, and a caller asking for a page has indeed found no page. Saying
 * instead "that id is a folder" would answer a question about a node the caller
 * may not be allowed to know exists — though in practice the space gate has
 * already passed by the time this runs.
 */
export function requireKind(node: Item, kind: 'page' | 'folder'): void {
  if (kindOf(node) !== kind) notFound(kind === 'folder' ? 'Folder not found' : 'Page not found');
}

// ─── Locating ────────────────────────────────────────────────────────────────

/**
 * The space a page belongs to, from the page id alone.
 *
 * Page ids travel without their space: shared links, links inside a body, ids
 * handed to an MCP client. The locator record is written once at creation and
 * never rewritten, so this is one extra read and the permission check still
 * happens afterwards, against the space this returns.
 */
export async function locatePage(pageId: string): Promise<string> {
  const ref = await table.get({ pk: pageRefPk(pageId), sk: PAGE_REF_SK });
  if (ref === null || ref.spaceId === undefined) notFound('Page not found');
  return ref.spaceId;
}

export async function readPage(spaceId: string, pageId: string): Promise<Item> {
  const page = await table.get({ pk: spacePk(spaceId), sk: pageSk(pageId) });
  // A locator record outliving its page is an expected intermediate state: the
  // delete path removes the page metadata first.
  if (page === null || page.type !== 'PAGE') notFound('Page not found');
  return page;
}

// ─── Tree ────────────────────────────────────────────────────────────────────

/**
 * Direct children, in sibling order.
 *
 * `limit` and `cursor` are the keyset paging contract every listing follows:
 * a parent's child count has no ceiling, and reading all of it to
 * answer "what is under this node" would put the read cost of the tree view in
 * proportion to the widest node in the space.
 */
export async function childrenOf(
  spaceId: string,
  parentPageId?: string,
  options?: { limit?: number; cursor?: string | null; order?: 'asc' | 'desc' },
): Promise<Item[]> {
  return await Array.fromAsync(
    table.query({
      index: 'gsi1',
      where: {
        gsi1pk: { equals: parentKey(spaceId, parentPageId) },
        // `null` counts as "no cursor", not as a cursor. An omitted argument
        // reaches the API as `null` over JSON-RPC, and reading that as a real
        // cursor turns the first page of results into an empty list — a
        // failure that looks like "this page has no children".
        ...(options?.cursor === undefined || options.cursor === null || options.cursor === ''
          ? {}
          : { gsi1sk: { greaterThan: options.cursor } }),
      },
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      ...(options?.order === undefined ? {} : { order: options.order }),
    }),
  );
}

/** The sibling sitting first or last under a parent, for placing a new one. */
export async function edgeSibling(
  spaceId: string,
  parentPageId: string | undefined,
  end: 'first' | 'last',
): Promise<Item | undefined> {
  const found = await childrenOf(spaceId, parentPageId, {
    limit: 1,
    order: end === 'last' ? 'desc' : 'asc',
  });
  return found[0];
}

/**
 * The ancestors of a page, root first, excluding the page itself.
 *
 * This is the breadcrumb, and the price of holding no path. The walk stops at
 * `MAX_DEPTH` rather than trusting the data: two concurrent moves can each put
 * the other's page underneath it and form a cycle, which nothing detects at
 * write time.
 */
export async function ancestorsOf(spaceId: string, page: Item): Promise<Item[]> {
  const chain: Item[] = [];
  let parentId = page.parentPageId;
  while (parentId !== undefined && chain.length < MAX_DEPTH) {
    const parent = await table.get({ pk: spacePk(spaceId), sk: pageSk(parentId) });
    if (parent === null || parent.type !== 'PAGE') break;
    chain.push(parent);
    parentId = parent.parentPageId;
  }
  return chain.reverse();
}

/**
 * Refuse a move that would put a page inside its own subtree.
 *
 * Walks up from the intended parent. Checking one page at a time is all that is
 * possible without a transaction, so two simultaneous moves can still form a
 * cycle; the depth cap on every read path is what keeps that survivable.
 */
export async function requireNoCycle(
  spaceId: string,
  pageId: string,
  newParentId: string,
): Promise<void> {
  let cursor: string | undefined = newParentId;
  for (let step = 0; cursor !== undefined && step <= MAX_DEPTH; step++) {
    if (cursor === pageId) invalid('A page cannot be moved inside its own subtree');
    const item: Item | null = await table.get({ pk: spacePk(spaceId), sk: pageSk(cursor) });
    if (item === null || item.type !== 'PAGE') return;
    cursor = item.parentPageId;
  }
}

/** How many levels sit below `pageId`, counting the page itself as 1. */
export async function subtreeHeight(spaceId: string, pageId: string, cap: number): Promise<number> {
  let level = [pageId];
  let height = 1;
  while (height <= cap) {
    const below = (await Promise.all(level.map((id) => childrenOf(spaceId, id)))).flat();
    if (below.length === 0) return height;
    level = below.map((item) => idOf(item.sk));
    height += 1;
  }
  return height;
}

/**
 * Every page in the subtree rooted at `pageId`, the page itself included.
 *
 * Capped, and the cap is reported rather than silently applied: a cascading
 * delete of an unbounded subtree is exactly the unbounded synchronous work
 * this design refuses to put behind an API call.
 */
export async function collectSubtree(spaceId: string, root: Item): Promise<Item[]> {
  const collected = [root];
  let level = [idOf(root.sk)];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const below = (await Promise.all(level.map((id) => childrenOf(spaceId, id)))).flat();
    if (collected.length + below.length > CASCADE_LIMIT) {
      invalid(
        `That subtree holds more than ${CASCADE_LIMIT} pages; delete some of its branches first`,
      );
    }
    collected.push(...below);
    level = below.map((item) => idOf(item.sk));
  }
  return collected;
}

// ─── Sibling ordering ────────────────────────────────────────────────────────

/**
 * A position placing a page among the children of `parentPageId`.
 *
 * `afterPageId` names the sibling to land behind; `null` means first, and
 * `undefined` means last. Only the moved page is written — the siblings keep
 * the positions they have.
 */
export async function positionFor(
  spaceId: string,
  parentPageId: string | undefined,
  afterPageId: string | null | undefined,
  moving?: string,
): Promise<string> {
  // Only the neighbours matter, so only the neighbours are read. Loading the
  // whole sibling list would make placing one page cost as much as the widest
  // node in the space.
  if (afterPageId === undefined) {
    const last = await edgeSibling(spaceId, parentPageId, 'last');
    return after(last?.position, Date.now());
  }

  if (afterPageId === null) {
    const first = await edgeSibling(spaceId, parentPageId, 'first');
    if (first?.position === undefined) return after(undefined, Date.now());
    const slot = between('', first.position);
    if (slot !== null) return slot;
    // No digit fits below the first sibling, which happens only when its
    // position is all zeros. Dropping its last character still sorts below it,
    // because a proper prefix always does — and unlike appending, it honours
    // what the caller actually asked for.
    if (first.position.length > 1) return first.position.slice(0, -1);
    invalid('There is no room before the first page; reorder its siblings first');
  }

  const anchor = await table.get({ pk: spacePk(spaceId), sk: pageSk(afterPageId) });
  if (
    anchor === null ||
    anchor.type !== 'PAGE' ||
    anchor.position === undefined ||
    anchor.parentPageId !== parentPageId
  ) {
    invalid(`Page ${afterPageId} is not a sibling at that position`);
  }
  // Two, so that the moved page being the anchor's current neighbour does not
  // hide the sibling it actually has to land in front of.
  const following = await childrenOf(spaceId, parentPageId, {
    cursor: siblingSk(anchor.position, afterPageId),
    limit: 2,
  });
  const next = following.find((item) => idOf(item.sk) !== moving);
  if (next?.position === undefined) return after(anchor.position, Date.now());

  const slot = between(anchor.position, next.position);
  // Two adjacent positions with nothing expressible between them. Appending
  // instead would silently drop the page somewhere else in the list, so this
  // says what happened rather than pretending the move worked.
  if (slot === null) invalid('There is no room between those two pages; reorder them first');
  return slot;
}

/** The `gsi1` pair a page item carries, given where it sits. */
export const siblingIndex = (spaceId: string, parentPageId: string | undefined, position: string, pageId: string) => ({
  gsi1pk: parentKey(spaceId, parentPageId),
  gsi1sk: siblingSk(position, pageId),
});

// ─── Bodies ──────────────────────────────────────────────────────────────────

/**
 * Write a revision and return its key.
 *
 * Each save goes to a key of its own, and the page metadata is what says which
 * key is current. Two people saving at once therefore never write to the same
 * object, and the one whose metadata write lands last is the one whose text is
 * shown — last-writer-wins, in the order the saves actually completed. The
 * loser's revision stays in the history rather than being lost.
 */
export async function writeBody(
  spaceId: string,
  pageId: string,
  revision: number,
  body: string,
): Promise<string> {
  const key = bodyKey(spaceId, pageId, revision, crypto.randomUUID());
  await content.put(key, body, { contentType: 'text/markdown; charset=utf-8' });
  return key;
}

export async function readBody(key: string | undefined): Promise<string> {
  if (key === undefined) return '';
  const file = await content.get(key);
  return file === null ? '' : file.body.toString('utf8');
}

// ─── Reclamation ─────────────────────────────────────────────────────────────

export const spaceReclaimPrefix = spacePrefix;
export const pageReclaimPrefix = pagePrefix;

/**
 * Promise that these S3 prefixes will be emptied. Writes only the promise.
 *
 * Called before anything is deleted. If the rest of the delete then fails, the
 * objects are still reachable from these records, which is the only thing
 * standing between an interrupted delete and content that nothing will ever
 * collect — there is no periodic sweeper.
 *
 * Submitting the job is deliberately *not* part of this. The job empties the
 * prefix, and the API is still deleting DynamoDB records at this point: a job
 * that started here could remove the bodies of pages whose metadata the request
 * has not managed to delete yet, and a caller who then opened one of those
 * pages would find it intact but empty. Reclamation is the last thing a delete
 * does — see `submitReclaim`.
 */
export async function promiseReclaim(prefixes: string[]): Promise<string[]> {
  if (prefixes.length === 0) return [];
  const createdAt = new Date().toISOString();
  const records = prefixes.map((prefix) => ({
    pk: CLEANUP_PK,
    sk: cleanupSk(createdAt, crypto.randomUUID()),
    type: 'CLEANUP' as const,
    prefix,
    createdAt,
  }));
  await table.putBatch(records);
  return records.map((record) => record.sk);
}

/**
 * Hand the promised reclamations to the job. The last step of any delete.
 *
 * One job per 200 handles, matching the payload cap. A failure here leaves the
 * records untouched, and a global administrator picks them up from
 * `listPendingCleanups()` — which is also what happens when a job exhausts its
 * retries and lands in the dead-letter queue.
 */
export async function submitReclaim(handles: string[]): Promise<void> {
  for (let i = 0; i < handles.length; i += 200) {
    await reclaimJob.submit({ handles: handles.slice(i, i + 200) });
  }
}

/** Page metadata and locator records for a set of pages, deleted together. */
export async function deletePageRecords(pages: Item[]): Promise<void> {
  if (pages.length === 0) return;
  // Metadata first, then the locator: a locator pointing at a page that is gone
  // resolves to a 404, while the reverse would hand out a page id that nothing
  // can turn back into a space.
  await table.deleteBatch(pages.map((page) => ({ pk: page.pk, sk: page.sk })));
  await table.deleteBatch(
    pages.map((page) => ({ pk: pageRefPk(idOf(page.sk)), sk: PAGE_REF_SK })),
  );
}

export { PAGE_SK_PREFIX, childrenOfPage };

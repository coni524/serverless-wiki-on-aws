/**
 * Page bodies and the freshness protocol that guards them.
 *
 * Holding, refetching, and persistence moved to TanStack Query (the client and
 * its IndexedDB persister live in `@/lib/react-query`); what stays here is the
 * stamp — the one rule Query must not be allowed to replace with time.
 *
 * A body is written to a new S3 key on every save and never overwritten, so a
 * body that was current under a given stamp is that body forever. The stamp is
 * `<revision>@<updatedAt>`: the revision alone collides, because two writers
 * saving from the same revision both take the next number while their bodies
 * differ.
 *
 * Two things are tracked, and the difference matters. Query's cache is what has
 * been read (and, for page bodies, restored from the previous session);
 * `freshness` is what the server most recently said the current stamp is,
 * learned from list responses that carry it anyway — and it is deliberately
 * *not* persisted, so a held body is shown without waiting only when a listing
 * fetched by this session (permission-filtered, like every listing) vouches for
 * it. Everything else waits for the server.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { api } from 'aws-blocks';
import { PERSIST_MAX_AGE_MS, clearPersistedCache, queryClient } from '@/lib/react-query';
import { attachmentsKey } from '@/features/pages/api/attachment-list';
import type { FolderDetail, Page, PageDetail } from '@/types/api';

/** A page detail that is known to carry its body. */
export type LoadedPage = Omit<PageDetail, 'body'> & { body: string };

/** What a list response says about one page, and what a held body was read as. */
type Stamped = { revision: number; updatedAt?: string };

export const stampOf = (page: Stamped): string => `${page.revision}@${page.updatedAt ?? ''}`;

export const pageKey = (pageId: string): QueryKey => ['page', pageId];

/** The key `treeLevelKey` uses for a space root, which has no parent page id. */
export const ROOT_LEVEL = '';

export const treeLevelKey = (spaceId: string, parentPageId: string | null): QueryKey => [
  'tree',
  spaceId,
  parentPageId ?? ROOT_LEVEL,
];

/** The key a folder's own record sits under: its name, its kind, its breadcrumb. */
export const folderKey = (folderId: string): QueryKey => ['folder', folderId];

/** One level of children, as far as it has been fetched. */
export type Level = { items: Page[]; cursor: string | null };

/**
 * The query behind one level of the tree.
 *
 * The tree and the folder screen ask the same question of the same parent, so
 * they are given the same entry rather than one each: a listing fetched by
 * either is on screen in both, and a write applied to that entry moves both in
 * the same frame.
 *
 * The queryFn notes each row's stamp — every row carries the revision and the
 * update time already, and recording them is what lets the page view decide,
 * with no request of its own, whether the body it holds is still the current
 * one.
 */
export function treeLevelQuery(spaceId: string, parentPageId: string | null) {
  return {
    queryKey: treeLevelKey(spaceId, parentPageId),
    queryFn: async (): Promise<Level> => {
      const result = await api.listChildPages(spaceId, parentPageId);
      noteFreshness(result.items);
      return { items: result.items, cursor: result.nextCursor };
    },
  };
}

/**
 * Fetch the next slice of a long level and append it to what is held.
 *
 * A refetch of the level starts over from the first slice, and that is
 * deliberate: a continuation is a reading position, not state worth defending
 * against a refetch.
 */
export async function loadMoreTreeLevel(
  spaceId: string,
  parentPageId: string | null,
  cursor: string,
): Promise<void> {
  const result = await api.listChildPages(spaceId, parentPageId, cursor);
  noteFreshness(result.items);
  queryClient.setQueryData<Level>(treeLevelKey(spaceId, parentPageId), (prev) => {
    if (prev === undefined) return { items: result.items, cursor: result.nextCursor };
    // A node moved into this level was inserted into the slices already held
    // (`noteMovedNode`), and the server places it last among its siblings — so
    // a later slice of a long level can carry the same row again. Held wins.
    const held = new Set(prev.items.map((item) => item.pageId));
    return {
      items: [...prev.items, ...result.items.filter((item) => !held.has(item.pageId))],
      cursor: result.nextCursor,
    };
  });
}

const freshness = new Map<string, string>();

/**
 * Record what the server just said about these pages.
 *
 * Called with any list that carries revisions — the page tree, mostly, which the
 * user has necessarily loaded before opening anything in it. This is what makes
 * the check on the next open local: no request is made to find out whether the
 * held body is still current.
 */
export function noteFreshness(pages: (Stamped & { pageId: string })[]): void {
  for (const page of pages) freshness.set(page.pageId, stampOf(page));
}

/**
 * Whether the server's last word agrees with this held body.
 *
 * Deliberately strict: with no observed stamp to compare against there is
 * nothing to justify showing a held body, so the caller waits for the fetch
 * instead. Showing a stale body as current is the one failure this protocol
 * must not have — which is also why the decision is made here and not by
 * Query's `staleTime`: time says how old a body is, not whether it is current.
 */
export function freshnessAgrees(pageId: string, page: LoadedPage): boolean {
  const observed = freshness.get(pageId);
  return observed !== undefined && observed === stampOf(page);
}

/**
 * Fetch the page, sending the stamp of whatever body is already held.
 *
 * Always goes to the server: an observed stamp can itself be old, and the body
 * this returns is the one the caller renders. What the stamp saves is the S3
 * read and the body on the wire when nothing has changed.
 *
 * A late response cannot resurrect a body a reset has dropped: the reset runs
 * through Query, which cancels what was in flight and ignores what it had
 * already handed off. The stale-stamp window that remains — a listing started
 * before a reset noting its stamps after it — is harmless on its own, because
 * the bodies those stamps would vouch for were dropped by the same reset.
 */
async function loadPage(pageId: string): Promise<LoadedPage> {
  const held = queryClient.getQueryData<LoadedPage>(pageKey(pageId));
  const page = await api.getPage(pageId, held === undefined ? null : stampOf(held));

  // `unchanged` is the server confirming the stamp, so the held body is the
  // current one. Everything else in the response — title, breadcrumb, parent —
  // is fresh either way and replaces what was held.
  const body = page.unchanged && held !== undefined ? held.body : (page.body ?? '');
  const loaded: LoadedPage = { ...page, body };
  freshness.set(pageId, stampOf(loaded));
  return loaded;
}

/**
 * The page body query. Refetches on every mount on purpose: opening a page
 * draws the held body at once when its stamp agrees, and asks the server either
 * way — the stamp makes that request cheap, not skippable.
 *
 * Exported as options rather than only as a hook, because the assistant's
 * review screen reads a page it may not have an id for yet and adds `enabled`
 * to these; what it must not add is a fetch of its own, or the body it diffs
 * against would be a second copy of the one the page view is showing.
 */
export function pageQuery(pageId: string) {
  return {
    queryKey: pageKey(pageId),
    queryFn: () => loadPage(pageId),
    refetchOnMount: 'always' as const,
    gcTime: PERSIST_MAX_AGE_MS,
  };
}

export function usePage(pageId: string) {
  return useQuery(pageQuery(pageId));
}

/**
 * Drop every node read from the server — bodies, tree levels, folders — and
 * fetch what is on screen again.
 *
 * The one caller is the assistant, whose writes land on the server with only
 * the chunk stream to say what they touched. Nothing on the client knows which
 * page the model created, renamed, or deleted, so nothing can apply the change
 * the way the tree does for its own edits.
 *
 * Reset rather than invalidate, and that is the point: invalidation keeps old
 * data on screen while the refetch runs, which right after a write means
 * showing the body the write just replaced — the most visible form of the one
 * failure this cache must not have.
 *
 * Every node, but only nodes. The assistant's write tools are `createPage`,
 * `updatePage` and `deletePage` (`WRITE_TOOLS` in `AiAssistant`), so the
 * identity, the space listings and the management screens are untouched by
 * anything this is called for — and resetting them would blank the shell around
 * a change that happened inside one page.
 */
export function resetServerState(): void {
  freshness.clear();
  for (const queryKey of [['tree'], ['page'], ['folder']]) {
    void queryClient.resetQueries({ queryKey });
  }
}

// ─── What a write does to the cache ─────────────────────────────────────────
// A write made from a screen that knows what it changed is applied to the
// cache; it does not reset it. Reset empties an entry and puts every view of it
// back to its loading state, so deleting one row would blank the whole tree and
// fetch it again to come back one row shorter — the flash the reader sees as
// the app reloading itself.
//
// Each function below does the same two things in the same order. What the
// caller already knows is written straight in (`setQueryData`), so the screen
// moves in the frame the write lands; what only the server can settle —
// sibling order, the `hasChildren` flags further up, the breadcrumbs that carry
// ancestor titles — is invalidated, which refetches in the background and
// leaves what is on screen alone until the answer arrives.
//
// None of this is optimistic: every one of them is called after the API has
// answered, so the cache is being told what happened, not what was hoped for.

/** Rewrite one level in place, if it is held at all. Absent means nothing to fix. */
function editLevel(
  spaceId: string,
  parentPageId: string | null,
  edit: (level: Level) => Level,
): void {
  queryClient.setQueryData<Level>(treeLevelKey(spaceId, parentPageId), (prev) =>
    prev === undefined ? prev : edit(prev),
  );
}

/**
 * Refetch what a structural write may have changed beyond the entries edited by
 * hand, without emptying any of them.
 *
 * Invalidate rather than reset: an invalidated query keeps its data on screen
 * while the refetch runs. That is safe here in a way it would not be for a body
 * — the page view's own guard is the stamp, and a write that did not touch a
 * body leaves that body's stamp exactly where it was, so a held body is still
 * the current one while its query revalidates.
 */
function revalidate(spaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['tree', spaceId] });
  void queryClient.invalidateQueries({ queryKey: ['page'] });
  void queryClient.invalidateQueries({ queryKey: ['folder'] });
}

/**
 * Every node the cache holds below this one, deepest last.
 *
 * Only what has been fetched can be listed, which is exactly what is wanted: a
 * level nobody opened has nothing cached to drop. `seen` bounds the walk, for
 * the same reason the tree render is depth-bounded — a cycle in the data must
 * not be able to hang the tab.
 */
function cachedDescendants(spaceId: string, pageId: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>([pageId]);
  const walk = (id: string) => {
    const level = queryClient.getQueryData<Level>(treeLevelKey(spaceId, id));
    if (level === undefined) return;
    for (const item of level.items) {
      if (seen.has(item.pageId)) continue;
      seen.add(item.pageId);
      found.push(item.pageId);
      walk(item.pageId);
    }
  };
  walk(pageId);
  return found;
}

/**
 * A node was created under `parentPageId`.
 *
 * The create call answers with an id and nothing else — not the position the
 * new node took among its siblings, nor the stamp the tree records — so the
 * level it landed in is asked again rather than guessed at. The rows already
 * drawn stay where they are while that runs, and the new one joins them.
 *
 * The level above it is asked again too, and it has to be: a row carries
 * whether it has children, and the first child ever created under a folder
 * turns that flag over. Left alone, the tree reads the flag it already had,
 * draws no expand arrow, never subscribes to the level below — and so never
 * fetches the child that would have corrected it. The new page opens in the
 * content area while the tree still shows its parent as a leaf.
 */
export function noteCreatedNode(spaceId: string, parentPageId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: treeLevelKey(spaceId, parentPageId) });
  revalidate(spaceId);
}

/**
 * A node was renamed.
 *
 * The title is the whole change and the caller is holding it, so the tree row,
 * the open page's heading, and the open folder's heading all take it at once.
 * The revalidate behind them is for the breadcrumbs: a renamed folder is an
 * ancestor of pages that draw its old title.
 */
export function noteRenamedNode(input: {
  spaceId: string;
  pageId: string;
  parentPageId: string | null;
  title: string;
}): void {
  editLevel(input.spaceId, input.parentPageId, (level) => ({
    ...level,
    items: level.items.map((item) =>
      item.pageId === input.pageId ? { ...item, title: input.title } : item,
    ),
  }));
  queryClient.setQueryData<LoadedPage>(pageKey(input.pageId), (prev) =>
    prev === undefined ? prev : { ...prev, title: input.title },
  );
  queryClient.setQueryData<FolderDetail>(folderKey(input.pageId), (prev) =>
    prev === undefined ? prev : { ...prev, title: input.title },
  );
  revalidate(input.spaceId);
}

/**
 * A node was deleted, and `children` says what became of what it held.
 *
 * The row leaves its level, and everything the cache knows about the nodes that
 * went with it is removed rather than invalidated — an invalidated entry would
 * refetch, and there is nothing there to fetch. A cascade takes the subtree, so
 * the ids are read out of the cache before the levels holding them are dropped.
 * A reparent leaves the children alive under the deleted node's own parent, and
 * that level is refetched by the revalidate below.
 */
export function noteDeletedNode(input: {
  spaceId: string;
  pageId: string;
  parentPageId: string | null;
  children: 'reject' | 'cascade' | 'reparent';
}): void {
  const { spaceId, pageId, parentPageId } = input;
  const gone =
    input.children === 'cascade' ? [pageId, ...cachedDescendants(spaceId, pageId)] : [pageId];

  editLevel(spaceId, parentPageId, (level) => ({
    ...level,
    items: level.items.filter((item) => item.pageId !== pageId),
  }));

  for (const id of gone) {
    queryClient.removeQueries({ queryKey: treeLevelKey(spaceId, id) });
    queryClient.removeQueries({ queryKey: pageKey(id) });
    queryClient.removeQueries({ queryKey: folderKey(id) });
    // The attachment rows go with the node for the same reason: the page they
    // belong to cannot be asked for them again.
    queryClient.removeQueries({ queryKey: attachmentsKey(id) });
    freshness.delete(id);
  }

  revalidate(spaceId);
}

/**
 * A node was moved to a new parent, and `page` is the row as it now stands —
 * the record the source level was holding, carrying the position the move
 * answered with.
 *
 * The row leaves the level it was in and joins the one it landed in, so the
 * tree moves in the frame the drop lands. The destination level may not be
 * held at all — a folder nobody has unfolded — and then there is nothing to
 * edit: the level is fetched complete, moved row included, when it first
 * appears on screen.
 *
 * The revalidate behind the edits is for everything a reparent changes beyond
 * the two levels: the `hasChildren` flags of both parents, and the breadcrumbs
 * of every page in the moved subtree.
 */
export function noteMovedNode(input: {
  spaceId: string;
  page: Page;
  fromParentId: string | null;
  toParentId: string | null;
}): void {
  const { spaceId, page } = input;
  editLevel(spaceId, input.fromParentId, (level) => ({
    ...level,
    items: level.items.filter((item) => item.pageId !== page.pageId),
  }));
  editLevel(spaceId, input.toParentId, (level) => ({
    ...level,
    items: [...level.items.filter((item) => item.pageId !== page.pageId), page],
  }));
  revalidate(spaceId);
}

/**
 * A page was saved: this body, under this stamp, is now what the server holds.
 *
 * This is the one write that may replace a body, and the reason it can be
 * written into the cache at all is that the save answers with the stamp it was
 * written under. Without it the body in hand could not be told apart from the
 * one it replaced, and the only safe move would be to drop it and read the page
 * back — which is what this used to do, at the cost of blanking the screen
 * right after a save.
 */
export function noteSavedPage(input: {
  spaceId: string;
  pageId: string;
  parentPageId: string | null;
  title: string;
  body: string;
  revision: number;
  updatedAt: string;
}): void {
  const { pageId, title, body, revision, updatedAt } = input;
  queryClient.setQueryData<LoadedPage>(pageKey(pageId), (prev) =>
    prev === undefined ? prev : { ...prev, title, body, revision, updatedAt },
  );
  freshness.set(pageId, stampOf({ revision, updatedAt }));
  editLevel(input.spaceId, input.parentPageId, (level) => ({
    ...level,
    items: level.items.map((item) =>
      item.pageId === pageId ? { ...item, title, revision, updatedAt } : item,
    ),
  }));
  revalidate(input.spaceId);
}

/**
 * The signed-in identity changed: drop everything, including the persisted
 * copy. Memory alone is not enough — the previous user's bodies are also on
 * disk now, and the next user must not inherit either.
 *
 * The memory side is dropped synchronously; the returned promise settles when
 * the disk-backed copy is gone too. Callers that are about to reload the page
 * await it, because a reload can cut the deletion short and leave the previous
 * user's bodies to be restored on the next start.
 */
export function dropServerState(): Promise<void> {
  freshness.clear();
  queryClient.clear();
  return clearPersistedCache();
}

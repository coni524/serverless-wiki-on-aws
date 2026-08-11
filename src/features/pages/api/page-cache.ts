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
import type { PageDetail } from '@/types/api';

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
 */
export function usePage(pageId: string) {
  return useQuery({
    queryKey: pageKey(pageId),
    queryFn: () => loadPage(pageId),
    refetchOnMount: 'always',
    gcTime: PERSIST_MAX_AGE_MS,
  });
}

/**
 * Fetch a page outside a component (the assistant's pending-change preview).
 * Goes through the query cache, so what it reads and stores is the same body
 * the page view shows.
 */
export function fetchPage(pageId: string): Promise<LoadedPage> {
  return queryClient.fetchQuery({
    queryKey: pageKey(pageId),
    queryFn: () => loadPage(pageId),
    staleTime: 0,
    gcTime: PERSIST_MAX_AGE_MS,
  });
}

/**
 * Drop everything read from the server and fetch what is on screen again.
 *
 * Reset rather than invalidate, and that is the point: invalidation keeps old
 * data on screen while the refetch runs, which right after a write means
 * showing the body the write just replaced — the most visible form of the one
 * failure this cache must not have. Reset drops to the loading state first,
 * exactly what the shell's remount-everything used to do.
 *
 * Whole-cache, not per page: writes are rare, and re-reading a handful of pages
 * costs less than a rule about which entries a given write invalidates.
 */
export function resetServerState(): void {
  freshness.clear();
  void queryClient.resetQueries();
}

/** A structural edit landed: every fetched tree level is stale, bodies are not. */
export function resetTreeLevels(): void {
  void queryClient.resetQueries({ queryKey: ['tree'] });
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

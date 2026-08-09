/**
 * Page bodies, held in memory for the life of the tab.
 *
 * A body is written to a new S3 key on every save and never overwritten, so a
 * body that was current under a given stamp is that body forever. The stamp is
 * `<revision>@<updatedAt>`: the revision alone collides, because two writers
 * saving from the same revision both take the next number while their bodies
 * differ.
 *
 * Two things are tracked, and the difference matters. `bodies` is what has been
 * read; `freshness` is what the server most recently said the current stamp is,
 * learned from list responses that carry it anyway. A body is shown without
 * waiting only when the two agree — everything else goes to the server.
 *
 * Nothing here persists: a reload starts empty. That alone does not bound a body
 * to the session that read it, because not every sign-out reloads — one in
 * another tab arrives over the auth channel and only re-renders. So the shell
 * calls `invalidateAll()` whenever the signed-in identity changes, from either
 * side, and that is what keeps one user's bodies out of the next user's tab
 * (`src/App.tsx`).
 */
import { api } from 'aws-blocks';
import type { PageDetail } from './lib';

/** A page detail that is known to carry its body. */
export type LoadedPage = Omit<PageDetail, 'body'> & { body: string };

/** What a list response says about one page, and what a held body was read as. */
type Stamped = { revision: number; updatedAt?: string };

export const stampOf = (page: Stamped): string => `${page.revision}@${page.updatedAt ?? ''}`;

const bodies = new Map<string, LoadedPage>();
const freshness = new Map<string, string>();

/**
 * Bumped by `invalidateAll()`, so a request that was already in flight when the
 * cache was dropped cannot put its answer back.
 *
 * Without it there is a way for a stale body to return after a write: the
 * assistant's write clears the cache, the page view is rebuilt and starts a new
 * request, and a request from before the write lands last — writing a body and a
 * matching stamp into the cache that the write has already replaced. This is the
 * same shape as the epoch check on the server (`aws-blocks/access.ts`), and it is
 * solved the same way: capture the generation before the request, compare after.
 */
let generation = 0;

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
 * The held body for this page, if the server's last word agrees with it.
 *
 * Synchronous and deliberately strict: with no observed stamp to compare
 * against there is nothing to justify showing a held body, so the caller waits
 * for `fetchPage()` instead. Showing a stale body as current is the one failure
 * this cache must not have.
 */
export function cachedPage(pageId: string): LoadedPage | null {
  const held = bodies.get(pageId);
  if (held === undefined) return null;
  const observed = freshness.get(pageId);
  if (observed === undefined || observed !== stampOf(held)) return null;
  return held;
}

/**
 * Fetch the page, sending the stamp of whatever body is already held.
 *
 * Always goes to the server: an observed stamp can itself be old, and the body
 * this returns is the one the caller renders. What the stamp saves is the S3
 * read and the body on the wire when nothing has changed.
 */
export async function fetchPage(pageId: string): Promise<LoadedPage> {
  const startedAt = generation;
  const held = bodies.get(pageId);
  const page = await api.getPage(pageId, held === undefined ? null : stampOf(held));

  // `unchanged` is the server confirming the stamp, so the held body is the
  // current one. Everything else in the response — title, breadcrumb, parent —
  // is fresh either way and replaces what was held.
  const body = page.unchanged && held !== undefined ? held.body : (page.body ?? '');
  const loaded: LoadedPage = { ...page, body };

  // Returned either way — the caller asked for this and drops it if it is no
  // longer the request it is waiting on — but only stored when nothing dropped
  // the cache while this was in flight.
  if (generation === startedAt) {
    bodies.set(pageId, loaded);
    freshness.set(pageId, stampOf(loaded));
  }
  return loaded;
}

/**
 * Drop everything held.
 *
 * Called at the *start* of the shell's refetch, before the version counters
 * move. The page view is rebuilt as soon as they do, and it reads this
 * cache before the tree's response comes back — so clearing afterwards would
 * hand it the body the write just replaced, right after the user approved that
 * write.
 *
 * Whole-cache, not per page: writes are rare, and re-reading a handful of pages
 * costs less than a rule about which entries a given write invalidates.
 */
export function invalidateAll(): void {
  generation += 1;
  bodies.clear();
  freshness.clear();
}

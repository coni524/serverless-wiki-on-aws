/**
 * Attachment bytes, kept in the browser's Cache Storage.
 *
 * An attachment id is never reused — replacing an image mints a new one — so
 * one id names the same bytes forever and nothing here has to invalidate on
 * change. What it must not do is skip the permission check: the caller signs
 * every id on every render, exactly as before, and only the transfer from S3
 * is avoided. Signing is where `read` is re-evaluated, and the whole
 * authorization story for attachments rests on that.
 *
 * Every failure path falls back to the signed URL itself, which is what the
 * caller used before this module existed. A browser with no Cache Storage, a
 * quota eviction, a fetch that fails: the picture still loads.
 */
const CACHE_NAME = 'sl-wiki-att-v1';

/** Cache Storage records neither a size nor a stored-at time, so we write one. */
const STORED_AT_HEADER = 'x-sl-cached-at';

/** Trim when there are more than this many entries, down to `TRIM_TO`. */
const MAX_ENTRIES = 300;
const TRIM_TO = 200;

/**
 * The cache key. Same-origin and synthetic: this path is never requested from
 * the server, it only has to be a stable name for the bytes.
 */
const keyFor = (attachmentId: string) =>
  `${location.origin}/__att/${encodeURIComponent(attachmentId)}`;

/** Cache Storage needs a secure context; `localhost` counts, so `pnpm run dev` has it. */
function storage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

export function isObjectUrl(url: string): boolean {
  return url.startsWith('blob:');
}

/** Release the object URLs a previous `cachedImageUrls()` handed out. */
export function revokeImageUrls(images: Record<string, string>): void {
  for (const url of Object.values(images)) {
    if (isObjectUrl(url)) URL.revokeObjectURL(url);
  }
}

/**
 * Swap signed URLs for object URLs backed by cached bytes.
 *
 * Ids already held are served without touching the network; the rest are
 * fetched once from the URL the API just signed and stored under their id. The
 * returned map has an entry for every id the caller passed, so a caller can
 * hand it straight to the renderer.
 *
 * The caller owns the object URLs and must pass the map to `revokeImageUrls()`
 * when it stops using them, or the browser holds the blobs for the tab's life.
 */
export async function cachedImageUrls(
  signed: Record<string, string>,
): Promise<Record<string, string>> {
  const store = storage();
  if (store === null) return signed;

  let cache: Cache;
  try {
    cache = await store.open(CACHE_NAME);
  } catch {
    return signed;
  }

  void trimOnce(cache);

  const entries = await Promise.all(
    Object.entries(signed).map(async ([id, url]) => [id, await resolveOne(cache, id, url)] as const),
  );
  return Object.fromEntries(entries);
}

let warned = false;

/**
 * Say once why the cache is not working.
 *
 * The fallback is silent by design — the picture still loads through the signed
 * URL — and that is exactly what would let a permanently broken cache go
 * unnoticed. The likeliest cause is the bucket having no CORS rules, which
 * happens when `CORS_ALLOWED_ORIGINS` was not passed to the deploy: fetching
 * then fails for every image on every render while the page looks perfectly
 * fine.
 */
function warnOnce(reason: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[sl-wiki] Could not cache an attachment; falling back to the signed URL. ' +
      'Images still load, but they are re-fetched on every render. If this is a CORS ' +
      'error, deploy with CORS_ALLOWED_ORIGINS set to this origin.',
    reason,
  );
}

async function resolveOne(cache: Cache, attachmentId: string, signedUrl: string): Promise<string> {
  const key = keyFor(attachmentId);
  try {
    const hit = await cache.match(key);
    if (hit !== undefined) return URL.createObjectURL(await hit.blob());

    // Default CORS mode on purpose. `no-cors` yields an opaque response, and
    // `cache.put()` refuses those — the image would load and never be stored.
    const response = await fetch(signedUrl);
    if (!response.ok) {
      warnOnce(`${response.status} fetching attachment ${attachmentId}`);
      return signedUrl;
    }

    const blob = await response.blob();
    const stored = new Response(blob, {
      headers: {
        'Content-Type': blob.type === '' ? 'application/octet-stream' : blob.type,
        [STORED_AT_HEADER]: new Date().toISOString(),
      },
    });
    // Storing may fail on a full quota. The bytes are already in hand, so that
    // is not a reason to fail the render.
    await cache.put(key, stored).catch(warnOnce);
    return URL.createObjectURL(blob);
  } catch (reason) {
    warnOnce(reason);
    return signedUrl;
  }
}

/** Drop one attachment's bytes, after the attachment itself is deleted. */
export async function forgetAttachment(attachmentId: string): Promise<void> {
  const store = storage();
  if (store === null) return;
  try {
    const cache = await store.open(CACHE_NAME);
    await cache.delete(keyFor(attachmentId));
  } catch {
    // A cache that cannot be opened has nothing to forget.
  }
}

/** How long sign-out waits for the deletion before going ahead without it. */
const CLEAR_TIMEOUT_MS = 2_000;

/**
 * Drop every cached attachment.
 *
 * Called on sign-out. Unlike the in-memory body cache, this one survives a
 * reload, so signing out has to say so explicitly.
 *
 * Awaited by the caller, because the reload that follows can abort a deletion
 * still in flight — but only up to a bound. Waiting without one puts a storage
 * layer that never answers in the way of signing out, and that trade is the
 * wrong way round: what is being deleted is hygiene, not a gate. Bytes left
 * behind cannot reach the next user, because every render signs each id afresh
 * and only ids the API signed are ever looked up here — so the cache is read for
 * an attachment only after the server has just granted `read` on it.
 */
export async function clearAttachmentCache(): Promise<void> {
  const store = storage();
  if (store === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      store.delete(CACHE_NAME),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLEAR_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Nothing to clear.
  } finally {
    clearTimeout(timer);
  }
}

let trimmed = false;

/**
 * Keep the cache from growing without bound, once per page load.
 *
 * This is a courtesy, not a guarantee: browsers evict on their own terms and do
 * it per origin, all at once, not entry by entry. Reading only the headers
 * keeps the pass cheap — the bodies are never touched.
 */
async function trimOnce(cache: Cache): Promise<void> {
  if (trimmed) return;
  trimmed = true;
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_ENTRIES) return;

    const dated = await Promise.all(
      keys.map(async (request) => {
        const response = await cache.match(request);
        return { request, storedAt: response?.headers.get(STORED_AT_HEADER) ?? '' };
      }),
    );
    dated.sort((a, b) => a.storedAt.localeCompare(b.storedAt));
    // Entries written before this module started stamping have an empty date and
    // sort first, which is the right guess about their age.
    await Promise.all(dated.slice(0, dated.length - TRIM_TO).map((e) => cache.delete(e.request)));
  } catch {
    // A trim that fails leaves a bigger cache, nothing worse.
  }
}

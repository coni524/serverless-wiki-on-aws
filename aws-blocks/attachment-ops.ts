/**
 * Attachment operations, expressed once for every caller.
 *
 * The same contract `wiki-ops.ts` holds for pages: each function takes a
 * resolved `Access` rather than a request context, and each re-checks the space
 * it is about to touch, so no caller can skip the check by holding an `Access`.
 * `attachments.ts` below this is the storage layer and decides nothing; this is
 * where the gate sits.
 *
 * The space is always resolved from the page id through the locator record —
 * never taken from the caller, which would let someone with access to one space
 * name another space's page.
 *
 * Two callers exist: the UI-facing API in `index.ts` and the sync API in
 * `ext.ts`. Uploads and downloads go straight from the client to S3
 * over a short-lived presigned URL; nothing here ever sees the bytes.
 */
import { content } from './resources.js';
import { attachmentKey } from './model.js';
import {
  ATTACHMENT_DOWNLOAD_URL_TTL,
  ATTACHMENT_UPLOAD_URL_TTL,
  MAX_ATTACHMENT_BYTES,
  MAX_SIGNED_ATTACHMENTS,
  deleteAttachmentObjects,
  findAttachment,
  listAttachmentFiles,
  locateAttachments,
} from './attachments.js';
import { locatePage, readPage } from './pages.js';
import { type Access, invalid, notFound, requireSpace } from './access.js';

const newId = () => crypto.randomUUID();

// ─── Input cleaning ──────────────────────────────────────────────────────────

/** A file name is both a display value and a key segment; keep it out of both traps. */
function cleanFilename(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') invalid('A file name is required');
  if (trimmed.length > 255) invalid('A file name may be at most 255 characters');
  // A separator would add a key segment; `.` / `..` are path traversal against
  // the filesystem-backed local mock; control characters have no place in a name.
  if (/[/\\]/.test(trimmed)) invalid('A file name may not contain a path separator');
  if (trimmed === '.' || trimmed === '..') invalid('A file name may not be "." or ".."');
  if (/[\x00-\x1f\x7f]/.test(trimmed)) invalid('A file name may not contain control characters');
  return trimmed;
}

/**
 * Content types allowed to keep their declared value. Everything else is signed
 * — and therefore served — as an opaque download.
 *
 * An allowlist, not a denylist: a type absent here (a new scriptable format, a
 * parameterized value, anything unrecognized) falls to `application/octet-stream`
 * on its own, so the set a browser will run inline off the S3 origin can never
 * grow behind our back. `text/html` and `image/svg+xml` are absent by
 * construction. Add to this list as real upload needs appear.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  // Images — `image/svg+xml` is deliberately excluded, as an SVG can carry script.
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'image/x-icon',
  'image/heic',
  'image/heif',
  // Documents and text — `text/html` / `*+xml` excluded, a browser runs them inline.
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Office
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  // Audio and video
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

/**
 * The content type to sign into the upload, and so the one S3 serves the object
 * back with. Only a recognized, safe type is kept; anything else becomes an
 * opaque download, because the presigned GET carries no `Content-Disposition`
 * to force that and the stored type is the only lever.
 */
function safeContentType(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.has(trimmed) ? trimmed : 'application/octet-stream';
}

/** Reject an id that could climb out of its S3 prefix on the local mock. */
function cleanAttachmentId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid('Invalid attachment id');
  return value;
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * A presigned URL to upload one attachment to a page.
 *
 * No record is written. An upload URL that is never used must leave nothing
 * behind, so the object appearing in S3 is the only thing that makes the
 * attachment real. The client must send the returned `contentType`
 * as the upload's `Content-Type`: it is signed into the URL, so S3 rejects a
 * mismatch, and it is also the type the download will serve back.
 *
 * `size` is the client's declared byte count, checked here against the cap.
 * The signature cannot carry a length condition — the block's `putUrl` takes
 * none — so a client that lies about it can still overrun. That object is
 * bounded, sits under the page prefix, and is reclaimed with the page; a hard
 * server-side cap would need a presigned POST and a direct AWS SDK call, which
 * this design deliberately keeps out.
 */
export async function createAttachmentUploadUrl(
  access: Access,
  input: { pageId: string; filename: string; contentType: string; size: number },
) {
  const spaceId = await locatePage(input.pageId);
  requireSpace(access, spaceId, 'write', 'Page');
  // The page must exist, not merely be locatable: a global administrator holds
  // `write` on every space id, so without this an attachment could be written
  // under a page whose prefix a reclamation job is already sweeping — the same
  // guard `createPage` puts on the space.
  await readPage(spaceId, input.pageId);

  const filename = cleanFilename(input.filename);
  if (!Number.isFinite(input.size) || input.size < 0) invalid('A file size is required');
  if (input.size > MAX_ATTACHMENT_BYTES) {
    invalid(`An attachment may be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB`);
  }
  const contentType = safeContentType(input.contentType);

  const attachmentId = newId();
  const uploadUrl = await content.putUrl(
    attachmentKey(spaceId, input.pageId, attachmentId, filename),
    { expiresIn: ATTACHMENT_UPLOAD_URL_TTL, contentType },
  );
  return { attachmentId, filename, contentType, uploadUrl, expiresIn: ATTACHMENT_UPLOAD_URL_TTL };
}

/**
 * The attachments on a page, newest first.
 *
 * The scan is scoped to this one page's prefix, and the `read` gate above is
 * the single permission filter every returned row has already passed — there
 * is no cross-space leakage left to strain out afterwards. The
 * block's `scan` has no cursor, so this returns the page's attachments in
 * full; the count is bounded per page, which is the trade the design accepted.
 */
export async function listAttachments(access: Access, pageId: string) {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'read', 'Page');
  await readPage(spaceId, pageId);
  return { items: await listAttachmentFiles(spaceId, pageId) };
}

/**
 * A presigned URL to download one attachment.
 *
 * The real key is read from S3 rather than rebuilt from a caller-supplied file
 * name, so the name cannot be forged and the URL always points at a real
 * object. Each call re-checks `read`, so a revoked grant stops downloads at
 * once.
 *
 * `readPage` confirms the page still has metadata, matching `listAttachments`
 * and the upload path: in the brief window of a delete where the locator
 * resolves but the page is gone, this reports the same 404 the other two do,
 * rather than handing out a link to an object a reclamation job is sweeping.
 */
export async function createAttachmentDownloadUrl(
  access: Access,
  pageId: string,
  attachmentId: string,
) {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'read', 'Page');
  await readPage(spaceId, pageId);
  const found = await findAttachment(spaceId, pageId, cleanAttachmentId(attachmentId));
  if (found === null) notFound('Attachment not found');
  const downloadUrl = await content.getUrl(found.key, { expiresIn: ATTACHMENT_DOWNLOAD_URL_TTL });
  return {
    downloadUrl,
    filename: found.filename,
    size: found.size,
    expiresIn: ATTACHMENT_DOWNLOAD_URL_TTL,
  };
}

/**
 * Presigned URLs for several of a page's attachments at once.
 *
 * This is what makes an image in the body visible. The body stores only
 * `attachment:<id>`, never a URL, because a URL cannot be stored: a presigned
 * one expires in a minute and an unsigned one would mean a publicly readable
 * object, which this design rules out. So the reader signs what the body
 * references, at the moment it renders, and every render re-checks `read` —
 * the same permission story a click on the attachment list already has.
 *
 * Ids with no object are absent from the result rather than an error. A body
 * outlives the attachment it points at (someone deleted the file, or the
 * reference was mistyped), and one dangling image must not take the whole page
 * down with it; the renderer shows its alt text instead.
 *
 * The cap bounds one request. The client sends at most this many, so a page
 * that somehow holds more still renders — the images past the cap fall back to
 * alt text — while a hand-built request cannot ask for an unbounded list.
 */
export async function createAttachmentDownloadUrls(
  access: Access,
  pageId: string,
  attachmentIds: string[],
) {
  // The shape of the request before the lookups, so a malformed one is refused
  // without reading DynamoDB or S3. Authentication still comes first.
  if (!Array.isArray(attachmentIds)) invalid('A list of attachment ids is required');
  if (attachmentIds.length > MAX_SIGNED_ATTACHMENTS) {
    invalid(`At most ${MAX_SIGNED_ATTACHMENTS} attachments can be signed at once`);
  }
  const ids = [...new Set(attachmentIds)].map(cleanAttachmentId);

  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'read', 'Page');
  await readPage(spaceId, pageId);

  const keys = await locateAttachments(spaceId, pageId, ids);
  // A null prototype, so an id that happens to name an inherited property —
  // `__proto__` above all — becomes an ordinary key instead of vanishing.
  const urls: Record<string, string> = Object.create(null);
  await Promise.all(
    [...keys].map(async ([attachmentId, key]) => {
      urls[attachmentId] = await content.getUrl(key, { expiresIn: ATTACHMENT_DOWNLOAD_URL_TTL });
    }),
  );
  return { urls, expiresIn: ATTACHMENT_DOWNLOAD_URL_TTL };
}

/**
 * Delete one attachment.
 *
 * Bounded to a single id's prefix, so unlike a page or space delete it runs
 * synchronously rather than through the reclamation job. Idempotent: removing
 * an attachment that is already gone is a no-op.
 */
export async function deleteAttachment(access: Access, pageId: string, attachmentId: string) {
  const spaceId = await locatePage(pageId);
  requireSpace(access, spaceId, 'write', 'Page');
  await deleteAttachmentObjects(spaceId, pageId, cleanAttachmentId(attachmentId));
  return { pageId, attachmentId };
}

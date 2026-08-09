/**
 * Attachment storage — listing, locating, and deletion.
 *
 * No DynamoDB record backs an attachment. The S3 object is the whole truth: the
 * listing is a prefix scan, a download is a presigned GET, and a delete removes
 * the object. Writing a record first was rejected — the API hands out an upload
 * URL and never learns whether the browser's direct upload landed, so a record
 * written up front would leave a phantom attachment in the listing whenever an
 * upload URL was issued but never used.
 *
 * Reclamation is not this module's concern: attachments sit under their page's
 * prefix, so `deletePage` and `deleteSpace` already sweep them with the bodies.
 *
 * Nothing here decides permissions. Every caller resolves the space from the
 * page id and gates on it first — see the API methods in `index.ts`.
 */
import { content } from './resources.js';
import { attachmentPrefix, attachmentsPrefix } from './model.js';

/** 25 MiB. Declared by the client at upload time and checked then; see the API. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * How many attachments one signing request may cover.
 *
 * Sized for a page body full of images, which is the only caller that asks for
 * more than one. The frontend caps its own request to match (`MAX_IMAGE_REFS` in
 * `src/markdown.ts`), so this bound is what stops a hand-built request, not
 * what the UI runs into.
 */
export const MAX_SIGNED_ATTACHMENTS = 200;

/**
 * How long a presigned URL stays valid — deliberately short.
 *
 * Upload and download are told apart on purpose. An upload has to carry up to
 * `MAX_ATTACHMENT_BYTES` over the wire, so it needs enough of a window for a
 * slow connection to finish. A download is fetched the instant the user clicks,
 * so its window is kept as small as the round trip allows — the shorter it is,
 * the less a leaked link (browser history, a shared URL, a log) can be replayed
 * without the permission check the API would otherwise impose.
 */
export const ATTACHMENT_UPLOAD_URL_TTL = 300;
export const ATTACHMENT_DOWNLOAD_URL_TTL = 60;

export type AttachmentInfo = {
  attachmentId: string;
  filename: string;
  size: number;
  uploadedAt: string;
};

/**
 * Split a full attachment key into its id and its decoded file name.
 *
 * Returns null for a key that is not one of ours — a stray object written
 * straight under `att/`, or one with an extra segment — so the listing skips it
 * rather than surfacing a malformed row.
 */
function parseAttachmentKey(
  spaceId: string,
  pageId: string,
  path: string,
): { attachmentId: string; filename: string } | null {
  const prefix = attachmentsPrefix(spaceId, pageId);
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  // An id, a slash, and a non-empty name — no more, no less.
  if (slash <= 0 || slash === rest.length - 1) return null;
  const attachmentId = rest.slice(0, slash);
  const encoded = rest.slice(slash + 1);
  if (encoded.includes('/')) return null;
  let filename: string;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return { attachmentId, filename };
}

/** Every attachment on a page, newest first. */
export async function listAttachmentFiles(
  spaceId: string,
  pageId: string,
): Promise<AttachmentInfo[]> {
  const found: AttachmentInfo[] = [];
  for await (const file of content.scan({ prefix: attachmentsPrefix(spaceId, pageId) })) {
    const parsed = parseAttachmentKey(spaceId, pageId, file.path);
    if (parsed === null) continue;
    found.push({
      attachmentId: parsed.attachmentId,
      filename: parsed.filename,
      size: file.size,
      uploadedAt: file.lastModified.toISOString(),
    });
  }
  return found.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** The stored object for one attachment id, or null if there is none. */
export async function findAttachment(
  spaceId: string,
  pageId: string,
  attachmentId: string,
): Promise<{ key: string; filename: string; size: number } | null> {
  // The prefix ends in a slash, so `att/<id>/` never picks up `att/<id2>/` where
  // one id is a prefix of another.
  for await (const file of content.scan({
    prefix: attachmentPrefix(spaceId, pageId, attachmentId),
  })) {
    const parsed = parseAttachmentKey(spaceId, pageId, file.path);
    if (parsed === null || parsed.attachmentId !== attachmentId) continue;
    return { key: file.path, filename: parsed.filename, size: file.size };
  }
  return null;
}

/**
 * The stored key for each of several attachment ids, in one prefix scan.
 *
 * `findAttachment` scans once per id, which is right for a single download and
 * wrong for a page body that references a dozen images. Ids with no object are
 * simply absent from the map — the caller decides what a missing one means.
 */
export async function locateAttachments(
  spaceId: string,
  pageId: string,
  attachmentIds: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(attachmentIds);
  const found = new Map<string, string>();
  if (wanted.size === 0) return found;
  for await (const file of content.scan({ prefix: attachmentsPrefix(spaceId, pageId) })) {
    const parsed = parseAttachmentKey(spaceId, pageId, file.path);
    if (parsed === null || !wanted.has(parsed.attachmentId)) continue;
    found.set(parsed.attachmentId, file.path);
  }
  return found;
}

/** Remove every object under one attachment id. Idempotent. */
export async function deleteAttachmentObjects(
  spaceId: string,
  pageId: string,
  attachmentId: string,
): Promise<void> {
  const keys: string[] = [];
  for await (const file of content.scan({
    prefix: attachmentPrefix(spaceId, pageId, attachmentId),
  })) {
    keys.push(file.path);
  }
  if (keys.length > 0) await content.deleteBatch(keys);
}

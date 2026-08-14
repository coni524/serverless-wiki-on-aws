/**
 * Images, between the Wiki's form and the vault's.
 *
 * A Wiki body never holds a URL for a picture it owns. It holds an id —
 * `![alt](attachment:<attachment id>)` — and the reader signs that id at the moment it
 * renders, which is where the `read` permission is checked. Nothing
 * in that scheme means anything to Obsidian, so a body copied into the vault
 * unchanged shows no pictures at all.
 *
 * So the two sides keep two forms of the same body, and this module is the only
 * place that knows both:
 *
 *   Wiki    ![diagram.png](attachment:8f3c…)
 *   vault   ![diagram.png](./_attachments/<page id>/diagram.png)
 *
 * The files sit in one folder per space, `_attachments/<page id>/`, and the
 * link is written relative to the note. Relative and not a wikilink: the vault
 * stays plain Markdown that any other editor renders, and the link means the
 * same thing to the Wiki's own renderer once the ids are put back.
 *
 * ─── What the record has to carry ───────────────────────────────────────────
 * `PageState.attachments` maps each id to the vault file holding it. It is not
 * derivable from the folder layout, because a picture the user pasted keeps the
 * place Obsidian put it — the plugin uploads it and remembers where it is
 * rather than moving a file the user may have embedded in another note too.
 *
 * `PageState.rendered` is the note path the links were computed against. A note
 * that moves takes its body with it but not the depth its `../` counted on, so
 * the next cycle re-renders the links from wherever the note now is.
 */
import { type App, TFile, requestUrl } from 'obsidian';

import type { SyncApi } from './api';
import { t } from './i18n';
import { ATTACHMENT_DIR, dirname, fileNameFromTitle } from './paths';

/** Attachment id → the vault file that holds it. */
export type AttachmentFiles = Record<string, string>;

/**
 * Read one entry of a map keyed by attachment id.
 *
 * Never `record[id]` on its own. Both of these maps are plain objects — one
 * parsed from the state file, one from the server's answer — and an id is
 * whatever a body wrote after `attachment:`. `attachment:toString` reads a
 * function off the prototype, and the value has to be a string for anything
 * here to be true of it.
 */
const lookup = (record: Record<string, string>, id: string): string | undefined => {
  const value = record[id];
  return typeof value === 'string' ? value : undefined;
};

export type AttachmentContext = {
  app: App;
  api: SyncApi;
  /** The space's folder in the vault, which is where `_attachments` lives. */
  spaceFolder: string;
  pageId: string;
};

/**
 * How many distinct attachments one body's links are resolved for.
 *
 * Matches `MAX_SIGNED_ATTACHMENTS` in `aws-blocks/attachments.ts`, which refuses
 * a longer signing request outright. Stopping at the cap here leaves the images
 * past it as plain links instead of costing the page every image it has.
 */
const MAX_REFS = 200;

/** The scheme a Wiki body points at its own attachments with. */
const SCHEME = 'attachment:';

/** Mirrors `cleanAttachmentId` on the server, which refuses anything else. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * `![alt](target)`, with the `<…>` form Markdown uses for a spaced path.
 *
 * Every quantifier is bounded by what follows it, which is what keeps the match
 * linear on a body a stranger wrote. The earlier form was quadratic twice over:
 * `[^\]]*` ran to the end of the body and backtracked once per `[` in it, and
 * the `\s*` on both sides of the target could split a run of spaces every
 * possible way, so `![](` and a megabyte of spaces never returned. `readLinks`
 * is the first thing both conversions do, so a body like that stopped the sync
 * — and Obsidian with it — on every cycle. The padding is one optional space
 * now rather than a run; the alt stops at the next `[`.
 */
const MARKDOWN_IMAGE = /!\[([^[\]\n]*)\]\(\s?(<[^<>\n]*>|[^()\s]*)\s?\)/g;

/** `![[target]]`, which is what Obsidian itself writes when an image is pasted. */
const WIKI_EMBED = /!\[\[([^[\]]+)\]\]/g;

/**
 * The types the Wiki serves back as the type they were uploaded as.
 *
 * A narrower list than the server's allowlist on purpose: what is uploaded here
 * is always something a body shows as a picture, and anything the server would
 * turn into `application/octet-stream` (an SVG above all, which can carry
 * script) would come back as a download rather than an image. A file with any
 * other extension keeps its local link and stays local — the alternative is
 * uploading bytes that the Wiki will never render.
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Where a page's attachments are kept in the vault. */
export const attachmentFolder = (spaceFolder: string, pageId: string): string =>
  `${spaceFolder}/${ATTACHMENT_DIR}/${pageId}`;

/** `g` regexes carry state between calls; this is the sole reason to reset it. */
function reset(body: string): string {
  MARKDOWN_IMAGE.lastIndex = 0;
  WIKI_EMBED.lastIndex = 0;
  return body;
}

// ─── Wiki → vault ────────────────────────────────────────────────────────────

/** Whose text a body is, which decides whether its links are believed. */
export type BodyOrigin = 'wiki' | 'vault';

/** An `attachment:<id>` target, which is the one form the Wiki owns. */
const ownAttachment = (target: string): boolean =>
  target.startsWith(SCHEME) && ATTACHMENT_ID.test(target.slice(SCHEME.length));

/**
 * A body from the Wiki with its picture links reduced to what the Wiki can mean.
 *
 * The Wiki shows a picture only for an attachment of the page it is on — every
 * other target renders as a link there, not an embed (`src/lib/markdown.tsx`). So a
 * body arriving from the Wiki that embeds `![](secret.png)` or
 * `![](../../another-space/_attachments/x/scan.png)` is naming a file in *this
 * vault*, which is something nobody on the Wiki side could have meant. Left as
 * an embed it is an instruction to the push half: `resolve()` finds whatever
 * file in the vault best matches the name, `toWikiBody` uploads its bytes as an
 * attachment of that page, and whoever wrote the body downloads them. A page in
 * one shared space would be reading files out of every other space the reader
 * mirrors, and out of notes that never sync at all.
 *
 * Dropping the leading `!` is the whole repair: the link stays in the note,
 * pointing where it pointed and reading as the Wiki renders it, and `readLinks`
 * no longer sees it, so nothing resolves it against the vault and nothing is
 * uploaded. Only the Wiki's own bodies are treated this way. A body read back
 * off disk carries the user's own links, and those are the plugin's business.
 */
function disarm(body: string): string {
  const links = readLinks(body);
  if (links.every((link) => ownAttachment(link.target))) return body;
  return rewrite(body, links, (index) => {
    const link = links[index];
    // `readLinks` reads `![…](…)` and `![[…]]`; both start with the `!`.
    return ownAttachment(link.target) ? null : body.slice(link.start + 1, link.end);
  });
}

export type VaultBodyResult = {
  body: string;
  /** The record to keep, which is empty exactly when the body shows no pictures. */
  files: AttachmentFiles;
  /** Attachments downloaded in the course of this call. */
  fetched: number;
  /**
   * Attachments the Wiki has and this call could not put on disk.
   *
   * Only those: an id the Wiki does not list is gone for good, and its link is
   * left dangling rather than retried every cycle for a picture that will never
   * arrive. What is here is worth asking for again, and the caller records it so
   * that the next cycle does — otherwise a single failed download leaves a
   * broken link in a body nobody is going to edit again (`sync.ts`).
   */
  pending: string[];
  failures: string[];
};

/**
 * The body as it should sit on disk, with the files it needs beside it.
 *
 * Every image link is read for which attachment it names — by its id when the
 * body came from the Wiki, and by what it points at when the body is already
 * the vault's own. Handling both is what lets one function write a fetched body
 * and repair a note that moved: the second case has no ids in it, only paths
 * that the record can still name.
 *
 * A link whose attachment cannot be resolved is left exactly as it was. A body
 * outlives the picture it points at, and one dangling image must not stop the
 * page from being written.
 *
 * `writtenFor` is where the links in `body` were resolvable from, which is not
 * `notePath` when a note has moved and is being written again: the links in it
 * still count folders from the place it used to be, and reading them at all
 * means starting there.
 *
 * `origin` says whose text this is, and only the Wiki's is disarmed — see
 * `disarm`. A body read back off disk is the vault's own and keeps every link
 * it has, which is what lets a moved note be repaired from the links in it.
 */
export async function toVaultBody(
  context: AttachmentContext,
  body: string,
  notePath: string,
  known: AttachmentFiles,
  writtenFor: string = notePath,
  origin: BodyOrigin = 'vault',
): Promise<VaultBodyResult> {
  const source = origin === 'wiki' ? disarm(body) : body;
  const result: VaultBodyResult = { body: source, files: {}, fetched: 0, pending: [], failures: [] };
  const links = readLinks(source);
  if (links.length === 0) return result;

  const files: AttachmentFiles = { ...known };
  const wanted: string[] = [];
  const named = new Map<number, string>();
  for (const [index, link] of links.entries()) {
    const id = identify(context, link, [writtenFor, notePath], files);
    if (id === null) continue;
    named.set(index, id);
    if (!wanted.includes(id) && wanted.length < MAX_REFS) wanted.push(id);
  }
  if (wanted.length === 0) return result;

  const placed = await materialize(context, wanted, files, result.failures);
  result.fetched = placed.fetched;
  result.pending = placed.pending;

  result.body = rewrite(source, links, (index) => {
    const id = named.get(index);
    if (id === undefined) return null;
    const path = lookup(files, id);
    return path === undefined ? null : markdownLink(links[index].alt, relativeTo(notePath, path));
  });
  // Only the ids this body still names are kept, so a picture removed from the
  // body stops being the plugin's business — the file stays where it is and the
  // attachment stays in the Wiki, which holds attachments a body never shows.
  for (const id of wanted) {
    const path = lookup(files, id);
    if (path !== undefined) result.files[id] = path;
  }
  return result;
}

/**
 * Which attachment a link names, or null when it names none of ours.
 *
 * The `attachment:` form answers directly. Anything else has to be resolved
 * against the vault and looked up in the record, which is what recognises the
 * plugin's own relative links — and only those, so a picture the user embedded
 * from elsewhere stays a local link until the push half uploads it.
 */
function identify(
  context: AttachmentContext,
  link: Link,
  from: string[],
  files: AttachmentFiles,
): string | null {
  if (link.target.startsWith(SCHEME)) {
    const id = link.target.slice(SCHEME.length);
    return ATTACHMENT_ID.test(id) ? id : null;
  }
  const file = resolve(context.app, from, link.target);
  if (file === null) return null;
  for (const [id, path] of Object.entries(files)) {
    if (path === file.path) return id;
  }
  return null;
}

/**
 * Put every wanted attachment on disk, downloading the ones that are not.
 *
 * The file names come from `listAttachments`, which is the only call that knows
 * them — the signing call answers with URLs alone. It is made once, and only
 * when something is actually missing, so a space whose pictures are already
 * mirrored costs no extra round trip per cycle.
 *
 * What could not be placed is reported rather than swallowed, and only for the
 * ids the Wiki said it has. An id absent from `listAttachments` names a picture
 * that has been deleted there, and asking again every cycle would buy nothing.
 */
async function materialize(
  context: AttachmentContext,
  wanted: string[],
  files: AttachmentFiles,
  failures: string[],
): Promise<{ fetched: number; pending: string[] }> {
  const nothing = { fetched: 0, pending: [] };
  const missing = wanted.filter((id) => {
    const path = lookup(files, id);
    return path === undefined || !(context.app.vault.getAbstractFileByPath(path) instanceof TFile);
  });
  if (missing.length === 0) return nothing;

  const listed = new Map<string, string>();
  for (const item of await context.api.listAttachments(context.pageId)) {
    listed.set(item.attachmentId, item.filename);
  }

  const present = missing.filter((id) => listed.has(id));
  if (present.length === 0) return nothing;
  const urls = await context.api.createAttachmentDownloadUrls(context.pageId, present);

  let fetched = 0;
  const pending: string[] = [];
  for (const id of present) {
    const url = lookup(urls, id);
    // Listed a moment ago and unsigned now, which is what a deletion in between
    // looks like. Kept for one more cycle rather than reported: if it was
    // deleted, the next `listAttachments` leaves it out and it stops being ours.
    if (url === undefined) {
      pending.push(id);
      continue;
    }
    try {
      const path = await download(context, url, id, listed.get(id) ?? id, files);
      files[id] = path;
      fetched += 1;
    } catch (error: unknown) {
      failures.push(t.attachmentFailure(id, error instanceof Error ? error.message : String(error)));
      pending.push(id);
    }
  }
  return { fetched, pending };
}

/** Fetch one attachment and write it under the page's folder. */
async function download(
  context: AttachmentContext,
  url: string,
  attachmentId: string,
  filename: string,
  files: AttachmentFiles,
): Promise<string> {
  const response = await requestUrl({ url, method: 'GET', throw: false });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(t.downloadRefused(response.status));
  }

  const folder = attachmentFolder(context.spaceFolder, context.pageId);
  await ensureFolder(context.app, folder);
  const path = freePath(context.app, folder, attachmentId, safeFileName(filename), files);

  const existing = context.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await context.app.vault.modifyBinary(existing, response.arrayBuffer);
  else await context.app.vault.createBinary(path, response.arrayBuffer);
  return path;
}

/**
 * A path inside the page's folder that no other attachment has taken.
 *
 * Two attachments on one page may carry the same file name — nothing in the
 * Wiki stops that, since an attachment is identified by its id. The id's first
 * characters are prefixed to the second one rather than to both, so the common
 * case keeps the name the user uploaded.
 */
function freePath(
  app: App,
  folder: string,
  attachmentId: string,
  filename: string,
  files: AttachmentFiles,
): string {
  const plain = `${folder}/${filename}`;
  const taken = Object.entries(files).some(([id, path]) => id !== attachmentId && path === plain);
  const mine = lookup(files, attachmentId) === plain;
  if (!taken && (mine || app.vault.getAbstractFileByPath(plain) === null)) return plain;
  return `${folder}/${attachmentId.slice(0, 8)}-${filename}`;
}

// ─── Vault → Wiki ────────────────────────────────────────────────────────────

export type WikiBodyResult = {
  body: string;
  files: AttachmentFiles;
  /** Pictures uploaded in the course of this call. */
  uploaded: number;
  failures: string[];
};

/**
 * The body as the Wiki should hold it, uploading pictures it does not have yet.
 *
 * A link the record already knows is turned straight back into its id. A link
 * pointing at any other file in the vault is a picture the user embedded, and
 * it is uploaded — which is the only way the Wiki's readers will see it, since
 * the Wiki cannot reach into the vault.
 *
 * The file itself is left exactly where Obsidian put it. Moving it into the
 * page's folder would break the same picture embedded in another note, and
 * copying it would put a second set of the same bytes in the vault; the record
 * naming where it is costs neither.
 *
 * `writtenFor` is where the links in `body` were written to be read from. It
 * matters when the user has moved the note since: reading a link that no longer
 * resolves would take a picture the Wiki already has for one it has never seen,
 * and upload a second copy of it.
 */
export async function toWikiBody(
  context: AttachmentContext,
  body: string,
  notePath: string,
  known: AttachmentFiles,
  writtenFor: string = notePath,
): Promise<WikiBodyResult> {
  const result: WikiBodyResult = { body, files: { ...known }, uploaded: 0, failures: [] };
  const links = readLinks(body);
  if (links.length === 0) return result;

  const ids = new Map<number, string>();
  for (const [index, link] of links.entries()) {
    // Already in the Wiki's own form. A body normally reaches here as the
    // vault's, but a user who typed the scheme by hand meant this id.
    if (link.target.startsWith(SCHEME)) continue;

    const file = resolve(context.app, [writtenFor, notePath], link.target);
    if (file === null) continue;

    const existing = Object.entries(result.files).find(([, path]) => path === file.path);
    if (existing !== undefined) {
      ids.set(index, existing[0]);
      continue;
    }

    const contentType = CONTENT_TYPES[file.extension.toLowerCase()];
    // Not a picture the Wiki would serve back as one. Left as a local link
    // rather than uploaded as an opaque download nobody can see in the page.
    if (contentType === undefined) continue;

    try {
      const attachmentId = await upload(context, file, contentType);
      result.files[attachmentId] = file.path;
      result.uploaded += 1;
      ids.set(index, attachmentId);
    } catch (error: unknown) {
      result.failures.push(
        `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (ids.size === 0) return result;

  result.body = rewrite(body, links, (index) => {
    const id = ids.get(index);
    return id === undefined ? null : markdownLink(links[index].alt, `${SCHEME}${id}`);
  });
  return result;
}

/** Send one file's bytes straight to S3 over a presigned URL. */
async function upload(context: AttachmentContext, file: TFile, contentType: string): Promise<string> {
  const bytes = await context.app.vault.readBinary(file);
  const issued = await context.api.createAttachmentUploadUrl({
    pageId: context.pageId,
    filename: file.name,
    contentType,
    size: bytes.byteLength,
  });
  // The type is signed into the URL, so S3 refuses anything else — and it is
  // also the type a download will serve back. The one the server answered with
  // is sent, not the one asked for, because the two differ whenever the server
  // declined to take the declared type at its word.
  const response = await requestUrl({
    url: issued.uploadUrl,
    method: 'PUT',
    headers: { 'Content-Type': issued.contentType },
    body: bytes,
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(t.uploadRefused(response.status));
  }
  return issued.attachmentId;
}

// ─── Links ───────────────────────────────────────────────────────────────────

type Link = { start: number; end: number; alt: string; target: string };

/**
 * Every image in a body, in the order they appear.
 *
 * Both notations are read. The Markdown one is what this plugin writes and what
 * the Wiki holds; the wikilink one is what Obsidian itself inserts when a
 * picture is pasted into a note, so a body that has never been through a cycle
 * arrives in that form.
 */
function readLinks(body: string): Link[] {
  const links: Link[] = [];

  for (const match of reset(body).matchAll(MARKDOWN_IMAGE)) {
    const raw = match[2];
    const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    if (target === '' || isExternal(target)) continue;
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      target,
    });
  }

  for (const match of reset(body).matchAll(WIKI_EMBED)) {
    // `![[picture.png|300]]` — the part after the bar is Obsidian's display
    // width, which has nowhere to go in the Wiki's form and is dropped with it.
    const target = match[1].split('|')[0].trim();
    if (target === '') continue;
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: target.slice(target.lastIndexOf('/') + 1),
      target,
    });
  }

  return links.sort((left, right) => left.start - right.start);
}

/** Replace the links a caller has an answer for, leaving the rest untouched. */
function rewrite(body: string, links: Link[], replacement: (index: number) => string | null): string {
  let out = '';
  let cut = 0;
  for (const [index, link] of links.entries()) {
    const text = replacement(index);
    if (text === null) continue;
    out += body.slice(cut, link.start) + text;
    cut = link.end;
  }
  return out + body.slice(cut);
}

const markdownLink = (alt: string, target: string): string => `![${alt}](${target})`;

/**
 * A target neither side of this module has anything to do with: a URL, or a
 * fragment. `attachment:` is a scheme too, and the one thing that is ours.
 */
function isExternal(target: string): boolean {
  if (target.startsWith(SCHEME)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//');
}

/**
 * The vault file a link points at, or null when it points at nothing.
 *
 * The written path is tried first, resolved against the note's own folder,
 * which is what this plugin writes. More than one folder is offered because a
 * note that has been moved carries links that still count from where it used
 * to be, and whether Obsidian rewrote them on the way depends on a setting
 * this plugin does not own — so both readings are tried and whichever finds a
 * file wins. Obsidian's own resolution answers last, because that is what a
 * pasted `![[picture.png]]` relies on: a bare name that means whichever file
 * in the vault best matches it.
 */
function resolve(app: App, from: string[], target: string): TFile | null {
  const cleaned = decode(target.split('#')[0].split('?')[0]);
  if (cleaned === '') return null;
  for (const notePath of from) {
    const direct = app.vault.getAbstractFileByPath(join(dirname(notePath), cleaned));
    if (direct instanceof TFile) return direct;
  }
  return app.metadataCache.getFirstLinkpathDest(cleaned, from[0]);
}

function decode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    // A literal `%` that is not an escape. The path is used as typed.
    return target;
  }
}

/** Resolve `.` and `..` against a folder, as a relative link means them. */
function join(folder: string, relative: string): string {
  const parts = folder === '' ? [] : folder.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * The link text for one file, seen from the note that shows it.
 *
 * Always leading with `./` or `../`, so the target is unmistakably a path and
 * not a bare name for Obsidian to look up across the whole vault — two spaces
 * mirroring pages of the same title would otherwise resolve to each other's
 * pictures. The segments are percent-encoded, which is how a space survives
 * inside Markdown's `(…)`.
 */
export function relativeTo(notePath: string, filePath: string): string {
  const from = dirname(notePath).split('/').filter((segment) => segment !== '');
  const to = filePath.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const up = Array<string>(from.length - shared).fill('..');
  const rest = to.slice(shared).map((segment) => encodeURIComponent(segment));
  return [...(up.length === 0 ? ['.'] : up), ...rest].join('/');
}

/** A file name the filesystem accepts, with its extension kept intact. */
function safeFileName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot + 1) : '';
  const suffix = /^[A-Za-z0-9]{1,10}$/.test(extension) ? `.${extension.toLowerCase()}` : '';
  return `${fileNameFromTitle(stem)}${suffix}`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  let walked = '';
  for (const segment of path.split('/')) {
    walked = walked === '' ? segment : `${walked}/${segment}`;
    if (app.vault.getAbstractFileByPath(walked) !== null) continue;
    try {
      await app.vault.createFolder(walked);
    } catch {
      // Created in between, by another cycle or by Obsidian itself.
      if (app.vault.getAbstractFileByPath(walked) === null) throw new Error(t.cannotCreateFolder(walked));
    }
  }
}

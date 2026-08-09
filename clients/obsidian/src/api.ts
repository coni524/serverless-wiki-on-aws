/**
 * The client for `POST /ext/<method>` — the Wiki's sync API.
 *
 * Plain JSON in, plain JSON out, one HTTP request per call. `requestUrl` rather
 * than `fetch`: it goes through Obsidian's own network layer, which sends no
 * `Origin` header, and the sync surface refuses a request whose `Origin` is not
 * the deployment's own (`guardOrigin` in `aws-blocks/bearer-auth.ts`).
 *
 * ─── The two refusals worth telling apart ───────────────────────────────────
 * A 401 is about the token and this module handles it: refresh once, retry once.
 * A 403 is about the user — the space refused them, or the token was never
 * granted `slwiki/write` — and no retry can help, so it is reported as it came.
 */
import { requestUrl } from 'obsidian';

import { AuthClient } from './auth';
import { t } from './i18n';
import type { RemoteNode } from './paths';
import { type SettingsHost, normalizeUrl } from './settings';

/** The fourteen methods of `aws-blocks/ext-methods.ts`. */
export type ExtMethod =
  | 'listSpaces'
  | 'listPages'
  | 'getPage'
  | 'createPage'
  | 'updatePage'
  | 'movePage'
  | 'deletePage'
  | 'createFolder'
  | 'renameFolder'
  | 'deleteFolder'
  | 'createAttachmentUploadUrl'
  | 'listAttachments'
  | 'createAttachmentDownloadUrls'
  | 'deleteAttachment';

/** What the user may do in a space; `read` makes the local folder fetch-only. */
export type Permission = 'read' | 'write' | 'admin';

export type SpaceSummary = {
  spaceId: string;
  name: string;
  description: string;
  permission?: Permission;
};

/** A refusal from the Wiki, carrying the status so a caller can branch on it. */
export class SyncApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

export class SyncApi {
  constructor(
    private readonly host: SettingsHost,
    private readonly auth: AuthClient,
  ) {}

  async call<T>(method: ExtMethod, args: Record<string, unknown> = {}): Promise<T> {
    const wikiUrl = normalizeUrl(this.host.settings.wikiUrl);
    if (wikiUrl === '') throw new SyncApiError(0, t.wikiUrlMissing);
    const url = `${wikiUrl}/ext/${method}`;

    const send = async (token: string) =>
      await requestUrl({
        url,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        throw: false,
      });

    let response = await send(await this.auth.accessToken());
    if (response.status === 401) {
      // The stored token was not the problem this plugin thought it was —
      // revoked, or the clock drifted. One refresh, one retry; a second 401 is
      // reported, because two in a row is not a token that expired.
      response = await send(await this.auth.refresh());
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SyncApiError(response.status, describeRefusal(method, response));
    }
    return JSON.parse(response.text) as T;
  }

  async listSpaces(): Promise<SpaceSummary[]> {
    const result = await this.call<{ spaces: SpaceSummary[] }>('listSpaces');
    return result.spaces;
  }

  /**
   * Every node in a space — pages and folders both — following the cursor to
   * the end.
   *
   * This is the snapshot a sync cycle is decided from, so it has to be the
   * whole space: a partial list would read as "these nodes were deleted in the
   * Wiki" and the mirror would trash them. The node count is bounded by the
   * space, and the cap only exists so that a cursor the server never retires
   * cannot spin here forever.
   *
   * `kind` is normalised here rather than trusted. A deployment from before
   * folders existed answers without it, and an undefined kind
   * reaching the mapping would place the node as neither.
   */
  async listAllNodes(spaceId: string): Promise<RemoteNode[]> {
    const nodes: RemoteNode[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 500; round += 1) {
      const result: NodeList = await this.call<NodeList>('listPages', {
        spaceId,
        ...(cursor === null ? {} : { cursor }),
      });
      for (const item of result.items) {
        nodes.push({ ...item, kind: item.kind === 'folder' ? 'folder' : 'page' });
      }
      cursor = result.nextCursor;
      if (cursor === null) return nodes;
    }
    throw new SyncApiError(0, t.pageListUnfinished(spaceId));
  }

  /**
   * One page, with its body unless `knownStamp` says the client already has it.
   *
   * An answer with `unchanged` set carries no `body` at all, which
   * is what keeps a cycle over an untouched space down to metadata.
   */
  async getPage(pageId: string, knownStamp?: string): Promise<PageDetail> {
    return await this.call<PageDetail>('getPage', {
      pageId,
      ...(knownStamp === undefined || knownStamp === '' ? {} : { knownStamp }),
    });
  }

  /**
   * Create a page for a note the Wiki does not have yet.
   *
   * `parentPageId` is sent as an explicit `null` for a page directly under the
   * space rather than left out, so that the value the plugin computed is the
   * value the Wiki reads. An omitted field and a null one mean different things
   * on `movePage` (see below), and spelling the top level the same way in both
   * places keeps the two calls from drifting apart.
   */
  async createPage(input: {
    spaceId: string;
    title: string;
    body: string;
    parentPageId: string | null;
  }): Promise<{ pageId: string; spaceId: string; revision: number }> {
    return await this.call('createPage', {
      spaceId: input.spaceId,
      title: input.title,
      body: input.body,
      parentPageId: input.parentPageId,
    });
  }

  /** Save a new title, a new body, or both. */
  async updatePage(
    pageId: string,
    patch: { title?: string; body?: string },
  ): Promise<{ pageId: string; revision: number }> {
    return await this.call('updatePage', { pageId, ...patch });
  }

  /**
   * Reparent a page to follow a note that moved between folders.
   *
   * Only the parent is sent. The order among siblings is the Wiki's to keep:
   * a filesystem has nowhere to hold an arbitrary order, so the plugin has no
   * opinion to send and leaving `afterPageId` out is what says so.
   */
  async movePage(pageId: string, parentPageId: string | null): Promise<void> {
    await this.call('movePage', { pageId, parentPageId });
  }

  /**
   * Delete a page whose note the user deleted.
   *
   * `reject` and not `cascade`: the notes are deleted deepest first, so a page
   * whose children went with it is already childless by the time its turn
   * comes. A page that still has children is one whose children the user kept,
   * and cascading there would delete pages they never touched.
   */
  async deletePage(pageId: string): Promise<void> {
    await this.call('deletePage', { pageId, children: 'reject' });
  }

  // ─── Folders ───────────────────────────────────────────────────────────────
  // A folder has three writes and no read: `listPages` already returns both
  // kinds with their `kind`, and that listing is the snapshot a cycle works
  // from. Moving one is `movePage`, which writes a parent and a position and
  // does not care which kind it is writing.

  /** Create a folder for a directory the user made in the vault. */
  async createFolder(input: {
    spaceId: string;
    title: string;
    parentPageId: string | null;
  }): Promise<{ folderId: string; spaceId: string }> {
    return await this.call('createFolder', {
      spaceId: input.spaceId,
      title: input.title,
      parentPageId: input.parentPageId,
    });
  }

  /** Rename a folder. The only thing about a folder there is to edit. */
  async renameFolder(folderId: string, title: string): Promise<void> {
    await this.call('renameFolder', { folderId, title });
  }

  /**
   * Delete a folder whose directory the user deleted.
   *
   * `reject`, for the same reason as a page and with the same ordering behind
   * it: removing a directory in the vault removes everything under it, the
   * plugin sends those deletions deepest first, and a folder that is still not
   * empty when its own turn comes holds something the Wiki has and the vault
   * never did. Refusing there reports that; `cascade` would delete it unseen.
   */
  async deleteFolder(folderId: string): Promise<void> {
    await this.call('deleteFolder', { folderId, children: 'reject' });
  }

  // ─── Attachments ───────────────────────────────────────────────────────────

  /**
   * The attachments on a page.
   *
   * Called for the file names alone: a body names an attachment by id, and this
   * is the only call that says what the file was called when it was uploaded.
   * The signing call below answers with URLs and nothing else.
   */
  async listAttachments(pageId: string): Promise<AttachmentInfo[]> {
    const result = await this.call<{ items: AttachmentInfo[] }>('listAttachments', { pageId });
    return result.items;
  }

  /**
   * Presigned download URLs for several of a page's attachments at once.
   *
   * Ids with no object behind them are simply absent from the answer rather
   * than an error, so the caller reads it as a lookup and not as a
   * promise that every id was found. The URLs expire within the minute, which
   * is why they are fetched immediately after this returns.
   */
  async createAttachmentDownloadUrls(
    pageId: string,
    attachmentIds: string[],
  ): Promise<Record<string, string>> {
    const result = await this.call<{ urls: Record<string, string> }>(
      'createAttachmentDownloadUrls',
      { pageId, attachmentIds },
    );
    return result.urls;
  }

  /**
   * A presigned URL to put one attachment on a page.
   *
   * Nothing is recorded by this call. The object appearing in S3 is what makes
   * the attachment real, so a URL that is issued and never used
   * leaves the page exactly as it was.
   */
  async createAttachmentUploadUrl(input: {
    pageId: string;
    filename: string;
    contentType: string;
    size: number;
  }): Promise<{ attachmentId: string; contentType: string; uploadUrl: string }> {
    return await this.call('createAttachmentUploadUrl', input);
  }
}

export type AttachmentInfo = {
  attachmentId: string;
  filename: string;
  size: number;
  uploadedAt: string;
};

type NodeList = { items: RemoteNode[]; nextCursor: string | null };

export type PageDetail = RemoteNode & {
  spaceId: string;
  /** Absent exactly when the caller's stamp still matched. */
  body?: string;
  unchanged: boolean;
};

/**
 * Turn a refusal into one line naming the method, the status, and the reason.
 *
 * The Wiki answers `/ext` with `{ error, error_description }` on the OAuth-shaped
 * refusals and with the framework's own error shape on the rest, so both are
 * read before falling back to the status alone.
 */
function describeRefusal(method: ExtMethod, response: { status: number; text: string }): string {
  let detail = '';
  try {
    const body = JSON.parse(response.text) as Record<string, unknown>;
    for (const key of ['error_description', 'message', 'error']) {
      const value = body[key];
      if (typeof value === 'string' && value !== '') {
        detail = value;
        break;
      }
    }
  } catch {
    detail = response.text.slice(0, 200);
  }
  return t.requestRefused(method, response.status, detail);
}

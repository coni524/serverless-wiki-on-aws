/**
 * The push half of the sync cycle.
 *
 * Everything here reads the vault and writes the Wiki, which is the exact
 * mirror of `sync.ts`. It runs first in a cycle, and the pull half runs after it
 * against a fresh snapshot — so the Wiki is the single place where the two
 * halves meet, and neither has to predict what the other will do.
 *
 * Both kinds of node travel this way. A directory in the vault is a
 * folder in the Wiki and a note is a page, so nothing here has to invent a node
 * on either side: a folder holding no notes is sent as a folder, and a note is
 * sent as a leaf.
 *
 * ─── How a difference gets a direction ──────────────────────────────────────
 * Three paths are compared for every node, not two:
 *
 *   entry.path        where the note or folder is now (the vault's answer)
 *   entry.syncedPath  where the plugin put it (the record's answer)
 *   planned.path      where this snapshot says it goes (the Wiki's answer)
 *
 * The user moved it when the first two differ; the Wiki moved it when the last
 * two do. Comparing both against the same middle term is what keeps a rename in
 * one place from being read as a rename in the other — with only "here" and
 * "there" to go on, a cycle cannot tell which side moved, and would push a
 * change back at whichever side had just made it.
 *
 * Bodies are told apart the same way: the recorded hash names the text as it
 * was written, so the file differing from it means the user edited it, and the
 * freshness mark differing from the snapshot's means the Wiki did.
 *
 * ─── What is deliberately not sent ──────────────────────────────────────────
 * - A page both sides changed. The Wiki wins, and the pull half keeps the local
 *   text as a conflict copy (the Wiki keeps its own losing revision, so
 *   neither text is lost). Placement is settled the same way.
 * - A note the user deleted, unless the space is set to reflect deletions.
 *   Deleting in the Wiki reaches the reclamation job and the bytes in S3 with
 *   it, and nothing in the vault is worth that by default.
 * - Conflict copies, and anything the pull half has already claimed a path for.
 * - The order of siblings. A filesystem has nowhere to keep an arbitrary order,
 *   so the plugin has no opinion to send.
 */
import { type App, TFile, TFolder } from 'obsidian';

import type { SpaceSummary, SyncApi } from './api';
import { type AttachmentContext, toWikiBody } from './attachments';
import { t } from './i18n';
import {
  ATTACHMENT_DIR,
  type Placement,
  type RemoteNode,
  basename,
  depthOf,
  dirname,
  isQuarantinePath,
  stampOf,
  stemOf,
  withoutIdSuffix,
} from './paths';
import { type SyncReport, describe } from './report';
import { type FolderState, type PageState, type SpaceState, contentHash } from './state';

export type PushContext = {
  space: SpaceSummary;
  /** The space's folder in the vault. */
  folder: string;
  /** The snapshot the cycle started from. */
  nodes: RemoteNode[];
  /** Where that snapshot says each node belongs. */
  plan: Placement;
  known: SpaceState;
  /** Whether a note the user deleted deletes the page in the Wiki. */
  reflectDeletes: boolean;
  report: SyncReport;
};

/**
 * Send one space's local changes.
 *
 * Returns whether anything reached the Wiki, which is the caller's cue to take
 * a fresh snapshot: the plan the pull half is about to work from was computed
 * before these writes, and a page created or renamed here is not in it.
 */
export async function pushSpace(app: App, api: SyncApi, context: PushContext): Promise<boolean> {
  return await new SpacePush(app, api, context).run();
}

class SpacePush {
  /** Every note under the space folder, minus the ones to leave alone. */
  private readonly files = new Map<string, TFile>();
  /** Every directory under it, minus the one holding the pictures. */
  private readonly dirs = new Set<string>();
  /** The snapshot, by node id. */
  private readonly remote = new Map<string, RemoteNode>();
  /** Note path → page id, for every page the record knows of. */
  private readonly notes = new Map<string, string>();
  /** Directory path → folder id, for every folder the record knows of. */
  private readonly folderIds = new Map<string, string>();
  /** The nodes this run may update or delete: those the Wiki still has. */
  private readonly trackedPages = new Map<string, PageState>();
  private readonly trackedFolders = new Map<string, FolderState>();
  /** Notes and directories belonging to no node, which makes them nodes to create. */
  private orphanNotes: string[] = [];
  private orphanDirs: string[] = [];
  /** Nodes created in this run, which cannot also be nodes deleted in it. */
  private readonly fresh = new Set<string>();
  private sent = false;

  constructor(
    private readonly app: App,
    private readonly api: SyncApi,
    private readonly context: PushContext,
  ) {}

  async run(): Promise<boolean> {
    const { space, folder, known, report } = this.context;
    // A space the user may only read is mirrored one way. Sending would earn a
    // refusal per page, and `listSpaces` already said so.
    if (space.permission === 'read') return false;

    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) {
      // Nothing to send from a folder that is not there — which is ordinary on
      // the first cycle of a newly chosen space, and alarming once pages have
      // been written into it. The same absence would otherwise read as "every
      // note was deleted", and in a space that reflects deletions it would
      // empty the space rather than report that the vault had moved.
      if (Object.keys(known.pages).length + Object.keys(known.folders).length > 0) {
        report.failures.push(t.pushFolderMissing(space.name, folder));
      }
      return false;
    }

    this.collect(root);
    await this.reuniteNotes();
    this.reuniteFolders();
    await this.create();
    await this.update();
    await this.remove();
    return this.sent;
  }

  // ─── Gathering ─────────────────────────────────────────────────────────────

  private collect(root: TFolder): void {
    const pictures = `${this.context.folder}/${ATTACHMENT_DIR}`;
    const walk = (folder: TFolder): void => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          // The pictures the plugin downloaded for this space. It stands for no
          // node, and a folder created for it would be a node standing for the
          // plugin's own bookkeeping.
          if (child.path === pictures) continue;
          this.dirs.add(child.path);
          walk(child);
        } else if (child instanceof TFile && child.extension === 'md') {
          // A conflict copy is the losing text this plugin set aside. Uploading
          // it would put that text back in the Wiki as a page of its own, which
          // is the one outcome setting it aside was meant to avoid.
          if (!isQuarantinePath(child.path)) this.files.set(child.path, child);
        }
      }
    };
    walk(root);

    for (const node of this.context.nodes) this.remote.set(node.pageId, node);

    // A node the Wiki no longer has is the pull half's business: it trashes the
    // note or removes the directory. Sending it back would resurrect what
    // somebody deleted.
    for (const [pageId, entry] of Object.entries(this.context.known.pages)) {
      this.notes.set(entry.path, pageId);
      if (this.remote.has(pageId)) this.trackedPages.set(pageId, entry);
    }
    for (const [folderId, entry] of Object.entries(this.context.known.folders)) {
      this.folderIds.set(entry.path, folderId);
      if (this.remote.has(folderId)) this.trackedFolders.set(folderId, entry);
    }

    // Paths the pull half has already spoken for are not free for the taking. A
    // note sitting on one is either a page being fetched for the first time or
    // a file that happens to share its name, and both are answered by the
    // conflict rule rather than by creating a second page with the same text.
    // The same holds of a directory: one the plan calls for stands for a node
    // the Wiki already has, whether or not this vault has met it yet.
    const claimed = new Set([...this.context.plan.nodes.values()].map((planned) => planned.path));
    this.orphanNotes = [...this.files.keys()].filter(
      (path) => !this.notes.has(path) && !claimed.has(path),
    );
    this.orphanDirs = [...this.dirs].filter(
      (path) => !this.folderIds.has(path) && !this.context.plan.containers.has(path),
    );
  }

  /**
   * Match a note that vanished to one that appeared, by what is written in it.
   *
   * Renames are normally followed as they happen (`state.trackRename`), but the
   * event only arrives while the plugin is loaded and not mid-cycle. A rename
   * made in Finder with Obsidian closed leaves a page whose note is missing and
   * a note belonging to no page, and reading that pair literally would create a
   * second page holding the same text — and, in a space that reflects
   * deletions, delete the first one.
   *
   * Only an unambiguous pair is joined: one missing page and one new note
   * sharing a body. Two empty notes have the same hash and mean nothing.
   *
   * Pairs are applied shallowest first, and the folders are reunited afterwards
   * from where these notes turned up (`reuniteFolders`).
   */
  private async reuniteNotes(): Promise<void> {
    const missing = [...this.trackedPages].filter(([, entry]) => !this.files.has(entry.path));
    if (missing.length === 0 || this.orphanNotes.length === 0) return;

    const wanted = new Map<string, string[]>();
    for (const [pageId, entry] of missing) {
      wanted.set(entry.hash, [...(wanted.get(entry.hash) ?? []), pageId]);
    }

    const found = new Map<string, string[]>();
    for (const path of this.orphanNotes) {
      const file = this.files.get(path);
      if (file === undefined) continue;
      const hash = await contentHash(await this.app.vault.read(file));
      found.set(hash, [...(found.get(hash) ?? []), path]);
    }

    const pairs: { pageId: string; path: string }[] = [];
    for (const [hash, paths] of found) {
      const ids = wanted.get(hash);
      if (paths.length !== 1 || ids === undefined || ids.length !== 1) continue;
      pairs.push({ pageId: ids[0], path: paths[0] });
    }
    pairs.sort((left, right) => depthOf(left.path) - depthOf(right.path));

    const claimed = new Set<string>();
    for (const { pageId, path } of pairs) {
      const entry = this.trackedPages.get(pageId);
      if (entry === undefined) continue;
      this.notes.delete(entry.path);
      entry.path = path;
      this.notes.set(path, pageId);
      claimed.add(path);
    }
    this.orphanNotes = this.orphanNotes.filter((path) => !claimed.has(path));
  }

  /**
   * Follow a folder renamed outside Obsidian, by where its contents turned up.
   *
   * A folder has no body, so the hash that reunites a note has no counterpart
   * here. What it does have is contents, and by the time this runs each of them
   * has been found — the notes by `reuniteNotes`, and the folders deeper down
   * by an earlier turn of this same loop, which is why it goes deepest first.
   * If everything the plugin put inside a folder is now inside one directory,
   * and that directory belongs to no node, then it is that folder under a new
   * name.
   *
   * Ambiguity is left alone. Contents that scattered across two directories say
   * the user did something this cannot name, and a folder left missing is
   * reported (or refused, when the space reflects deletions and the Wiki still
   * has children under it) rather than guessed at.
   */
  private reuniteFolders(): void {
    const missing = [...this.trackedFolders]
      .filter(([, entry]) => !this.dirs.has(entry.path))
      .sort(([, left], [, right]) => depthOf(right.path) - depthOf(left.path));

    for (const [folderId, entry] of missing) {
      // Keyed on where the plugin put the folder, not on where the record now
      // says it is: the contents remember the same place, and the two differ as
      // soon as the user has renamed the folder once already.
      const homes = new Set<string>();
      for (const inside of this.contentsOf(entry.syncedPath)) homes.add(dirname(inside));
      if (homes.size !== 1) continue;
      const [home] = homes;
      if (home === entry.path || !this.dirs.has(home)) continue;
      // Only a directory nothing else answers for. One the record or the plan
      // already ties to a node is that node's, and handing it to this folder on
      // the strength of where a few notes sit would merge two of them.
      if (this.folderIds.has(home) || this.context.plan.containers.has(home)) continue;

      this.folderIds.delete(entry.path);
      this.folderIds.set(home, folderId);
      entry.path = home;
      this.orphanDirs = this.orphanDirs.filter((path) => path !== home);
    }
  }

  /** Where the things the plugin put directly inside `dir` are now. */
  private *contentsOf(dir: string): Iterable<string> {
    for (const entry of this.trackedPages.values()) {
      if (dirname(entry.syncedPath) === dir && this.files.has(entry.path)) yield entry.path;
    }
    for (const entry of this.trackedFolders.values()) {
      if (dirname(entry.syncedPath) === dir && this.dirs.has(entry.path)) yield entry.path;
    }
  }

  // ─── Creating ──────────────────────────────────────────────────────────────

  /**
   * Give every directory without a folder one, and every note without a page,
   * shallowest first in both cases.
   *
   * Directories go first as a group. A note's parent has to exist before the
   * note can name it, and `folderFor` walks up as far as it has to, so the
   * depth order is what keeps that walk short rather than what makes it right.
   */
  private async create(): Promise<void> {
    const dirs = [...this.orphanDirs].sort((left, right) => depthOf(left) - depthOf(right));
    for (const dir of dirs) {
      // Already made, by the walk up from a deeper directory a moment ago.
      if (this.folderIds.has(dir)) continue;
      try {
        await this.folderFor(dir);
      } catch (error: unknown) {
        this.context.report.failures.push(`${dir}: ${describe(error)}`);
      }
    }

    const notes = [...this.orphanNotes].sort((left, right) => depthOf(left) - depthOf(right));
    for (const path of notes) {
      try {
        await this.sendPage(path, stemOf(path), await this.folderFor(dirname(path)));
      } catch (error: unknown) {
        this.context.report.failures.push(`${path}: ${describe(error)}`);
      }
    }
  }

  /**
   * The folder a directory stands for, creating one if the directory is new.
   *
   * `null` is the space itself, which is a parent but not a node.
   *
   * A directory the plan speaks for already has a node, even when this vault
   * has never met it: the folder the Wiki keeps there, or — until the migration
   * has run — a page that still has children. Naming that page as a
   * parent is refused by the Wiki, and the refusal is reported as it comes: a
   * page cannot hold children under the new rule, and quietly making a folder
   * beside it would put two nodes of the same name in the same place.
   */
  private async folderFor(dir: string): Promise<string | null> {
    if (dir === this.context.folder || dir === '') return null;

    const known = this.folderIds.get(dir);
    if (known !== undefined) return known;

    const planned = this.context.plan.containers.get(dir);
    if (planned !== undefined) return planned;

    const parent = await this.folderFor(dirname(dir));
    const created = await this.api.createFolder({
      spaceId: this.context.space.spaceId,
      title: basename(dir),
      parentPageId: parent,
    });

    this.sent = true;
    this.context.report.created += 1;
    this.fresh.add(created.folderId);
    this.folderIds.set(dir, created.folderId);
    this.context.known.folders[created.folderId] = { path: dir, syncedPath: dir };
    return created.folderId;
  }

  /** Create one page and remember where its note is. */
  private async sendPage(
    notePath: string,
    title: string,
    parentPageId: string | null,
  ): Promise<string> {
    const file = this.files.get(notePath);
    const body = file === undefined ? '' : await this.app.vault.read(file);
    const created = await this.api.createPage({
      spaceId: this.context.space.spaceId,
      title,
      body,
      parentPageId,
    });

    this.sent = true;
    this.context.report.created += 1;
    this.fresh.add(created.pageId);
    this.notes.set(notePath, created.pageId);
    const entry: PageState = {
      path: notePath,
      syncedPath: notePath,
      // Left blank so the pull half asks for the body and records the mark the
      // Wiki actually assigned. The write's answer carries the revision but not
      // the update time, and taking the pair from the snapshot afterwards would
      // name a body somebody else may have written in between.
      stamp: '',
      hash: await contentHash(body),
    };
    this.context.known.pages[created.pageId] = entry;

    // The pictures follow in a second call, because an upload URL is issued
    // against a page id and there was no page id until a moment ago.
    // So a new note reaches the Wiki with the links it was written with, and
    // they become attachment ids as soon as the bytes are there.
    const wiki = await this.toWiki(created.pageId, entry, body);
    if (wiki !== body) await this.api.updatePage(created.pageId, { body: wiki });
    return created.pageId;
  }

  /**
   * The body as the Wiki should hold it, uploading the pictures it lacks.
   *
   * A local link is only turned into an attachment id here; the file stays
   * where it is in the vault, and the record remembers which id it answers to
   * (`attachments.ts`). What the vault holds and what the Wiki holds are the
   * same body written two ways, and this is one of the two directions.
   */
  private async toWiki(pageId: string, entry: PageState, body: string): Promise<string> {
    const context: AttachmentContext = {
      app: this.app,
      api: this.api,
      spaceFolder: this.context.folder,
      pageId,
    };
    const converted = await toWikiBody(
      context,
      body,
      entry.path,
      entry.attachments ?? {},
      // Where the links in the file were written to be read from, which is not
      // where the file is once the user has moved it. Reading them from the new
      // place would find nothing and upload a second copy of every picture.
      entry.rendered ?? entry.path,
    );
    this.context.report.uploaded += converted.uploaded;
    for (const failure of converted.failures) {
      this.context.report.failures.push(`${entry.path}: ${failure}`);
    }
    // `rendered` is deliberately not touched. This half does not rewrite the
    // file, so the links in it still count from wherever they were written; the
    // pull half writes them again and says so then.
    if (Object.keys(converted.files).length > 0) entry.attachments = converted.files;
    return converted.body;
  }

  // ─── Updating ──────────────────────────────────────────────────────────────

  /** Parents before children, so a node moves before what hangs off it. */
  private async update(): Promise<void> {
    const work: { path: string; run: () => Promise<void> }[] = [];
    for (const [folderId, entry] of this.trackedFolders) {
      work.push({ path: entry.path, run: async () => await this.updateFolder(folderId, entry) });
    }
    for (const [pageId, entry] of this.trackedPages) {
      work.push({ path: entry.path, run: async () => await this.updatePage(pageId, entry) });
    }
    work.sort((left, right) => depthOf(left.path) - depthOf(right.path));

    for (const item of work) {
      try {
        await item.run();
      } catch (error: unknown) {
        this.context.report.failures.push(`${item.path}: ${describe(error)}`);
      }
    }
  }

  /**
   * Send a folder's new name, its new parent, or neither.
   *
   * There is nothing else a folder can have changed: it holds no body, and the
   * order among its siblings is the Wiki's to keep. `movePage` is what moves it
   * — the call writes a parent and a position, and does not care which kind of
   * node it is writing.
   */
  private async updateFolder(folderId: string, entry: FolderState): Promise<void> {
    const node = this.remote.get(folderId);
    // Not where the record says. Either the user deleted the directory, or they
    // moved it out of sight of both the rename event and the reunion above;
    // `remove` decides, and the pull half puts it back when it does not.
    if (node === undefined || !this.dirs.has(entry.path)) return;

    const planned = this.context.plan.nodes.get(folderId);
    if (planned === undefined || planned.path !== entry.syncedPath) return;

    const name = basename(entry.path);
    if (name !== basename(entry.syncedPath)) {
      const title = withoutIdSuffix(name, folderId).trim();
      if (title !== '') {
        await this.api.renameFolder(folderId, title);
        this.sent = true;
        this.context.report.updated += 1;
      }
    }

    // `parent !== folderId` guards the one way a directory can resolve to the
    // node inside it: a node whose own record still puts it under its container
    // rather than beside it, which is what a vault mirrored by the previous
    // mapping looks like until the pull half has moved the file.
    const parent = await this.folderFor(dirname(entry.path));
    if (parent !== (node.parentPageId ?? null) && parent !== folderId) {
      await this.api.movePage(folderId, parent);
      this.sent = true;
      this.context.report.relocated += 1;
    }
  }

  private async updatePage(pageId: string, entry: PageState): Promise<void> {
    const page = this.remote.get(pageId);
    const file = this.files.get(entry.path);
    // Not where the record says. Either the user deleted it, or they moved it
    // out of sight of both the rename event and the reunion above; `remove`
    // decides, and the pull half puts it back when it does not.
    if (page === undefined || file === undefined) return;

    const patch: { title?: string; body?: string } = {};
    const planned = this.context.plan.nodes.get(pageId);
    // The Wiki moved or renamed it too — or could not place it at all. Two
    // answers to where the page belongs, so the Wiki's is taken and the note
    // follows in the pull half, the same way a body conflict is settled.
    const settled = planned !== undefined && planned.path === entry.syncedPath;

    if (settled) {
      const title = this.renamedTo(pageId, entry);
      if (title !== null) patch.title = title;

      const parent = await this.folderFor(dirname(entry.path));
      if (parent !== (page.parentPageId ?? null) && parent !== pageId) {
        await this.api.movePage(pageId, parent);
        this.sent = true;
        this.context.report.relocated += 1;
        entry.stamp = '';
      }
    }

    const body = await this.app.vault.read(file);
    const hash = await contentHash(body);
    // Sent only when the Wiki's copy is still the one this body was written
    // from. When it is not, both sides changed and the pull half keeps the
    // local text as a conflict copy before writing the Wiki's over it.
    if (hash !== entry.hash && stampOf(page) === entry.stamp) {
      patch.body = await this.toWiki(pageId, entry, body);
    }

    if (patch.title === undefined && patch.body === undefined) return;
    await this.api.updatePage(pageId, patch);
    this.sent = true;
    this.context.report.updated += 1;
    // Blanked for the same reason as on creation: the pull half re-reads the
    // page and records the mark the Wiki assigned to this write.
    entry.stamp = '';
    if (patch.body !== undefined) entry.hash = hash;
  }

  /**
   * The title the user gave a page by renaming its file, or null for no rename.
   *
   * The comparison is against the name the plugin last wrote and not against
   * the title itself, because the two are not the same string: a title with a
   * `/` or a `:` in it becomes a file name with a `-`, and a title clashing
   * with a sibling gains a suffix. Reading the file name back as the title
   * would rewrite every such page's title on the first cycle.
   */
  private renamedTo(pageId: string, entry: PageState): string | null {
    const synced = stemOf(entry.syncedPath);
    const note = stemOf(entry.path);
    if (note === synced) return null;
    const title = withoutIdSuffix(note, pageId).trim();
    return title === '' ? null : title;
  }

  // ─── Deleting ──────────────────────────────────────────────────────────────

  /**
   * Delete the nodes whose notes and directories are gone, deepest first.
   *
   * Deepest first is what lets every call say `reject`: a node whose children
   * were deleted along with it is childless by the time its own turn comes, and
   * one that still has children is one whose children the user kept, or one the
   * Wiki has and this vault never received — refusing there is the right
   * answer, and the refusal is reported rather than worked around. Removing a
   * directory in Obsidian removes everything inside it, so a folder reaches
   * this with every one of its own contents already in the list.
   *
   * Deletions are applied last so that a node is not deleted out from under
   * children that were moved elsewhere earlier in the same run.
   *
   * A page with no freshness mark is never among them. That mark is blanked by
   * every write this half makes and filled in again by the pull half, so its
   * absence means "written but not yet read back". Reading a note the pull half
   * has still to write as a deletion would delete the page a moment after
   * making it; for folders the same job is done by `fresh` alone, there being
   * no body to read back.
   */
  private async remove(): Promise<void> {
    if (!this.context.reflectDeletes) return;

    const gone: { path: string; run: () => Promise<void> }[] = [];
    for (const [pageId, entry] of this.trackedPages) {
      if (this.fresh.has(pageId) || entry.stamp === '' || this.files.has(entry.path)) continue;
      gone.push({
        path: entry.path,
        run: async () => {
          await this.api.deletePage(pageId);
          delete this.context.known.pages[pageId];
        },
      });
    }
    for (const [folderId, entry] of this.trackedFolders) {
      if (this.fresh.has(folderId) || this.dirs.has(entry.path)) continue;
      gone.push({
        path: entry.path,
        run: async () => {
          await this.api.deleteFolder(folderId);
          delete this.context.known.folders[folderId];
        },
      });
    }
    gone.sort((left, right) => depthOf(right.path) - depthOf(left.path));

    for (const item of gone) {
      try {
        await item.run();
        this.sent = true;
        this.context.report.deleted += 1;
      } catch (error: unknown) {
        this.context.report.failures.push(`${item.path}: ${describe(error)}`);
      }
    }
  }
}

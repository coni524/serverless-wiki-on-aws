/**
 * One sync cycle, and the pull half of it.
 *
 * A cycle visits each chosen space twice. First the vault writes the Wiki
 * (`push.ts`), then the Wiki writes the vault, which is everything below. The
 * two are separated by a fresh snapshot rather than by bookkeeping: a page
 * created or renamed a moment ago is simply in the second snapshot, so the pull
 * half never has to be told what the push half just did.
 *
 * The order the pull half works in, and why it is that order, is on
 * `pullSpace` below.
 *
 * When both sides changed the same page, this half wins and the local text is
 * kept beside it under a name of its own. The Wiki keeps the losing side of its
 * own collisions as a revision; nothing but a conflict copy keeps
 * the vault's.
 */
import { type App, TFile, TFolder } from 'obsidian';

import type { SpaceSummary, SyncApi } from './api';
import {
  type AttachmentContext,
  attachmentFolder,
  disarmTargets,
  disarmWritten,
  toVaultBody,
  wikiTargets,
} from './attachments';
import { t } from './i18n';
import {
  ATTACHMENT_DIR,
  type Placement,
  type PlannedNode,
  type RemoteNode,
  depthOf,
  dirname,
  isQuarantinePath,
  planNodes,
  planSpaceFolders,
  quarantineOrigin,
  quarantinePath,
  stampOf,
} from './paths';
import { pushSpace } from './push';
import { type SyncReport, describe, emptyReport } from './report';
import { type PageState, type SpaceState, type SyncStateStore, contentHash } from './state';

export type { SyncReport } from './report';

/** What the settings say about the spaces a cycle covers. */
export type SyncOptions = {
  /** The spaces mirrored into the vault. */
  spaceIds: string[];
  /** Those among them where deleting a note deletes the page (default: none). */
  deleteSpaceIds: string[];
  /**
   * Space id → the existing, non-empty folder the user agreed to import on the
   * space's first cycle. Without an entry naming the very folder the space
   * maps to, such a space is paused rather than synced.
   */
  adoptFolders: Record<string, string>;
};

export class SyncEngine {
  private running = false;
  /** The last cycle's outcome, for the settings screen to show. */
  last: { at: number; report: SyncReport } | null = null;
  /**
   * Space id → the folder a space is paused on, awaiting the user's word that
   * it may be imported. As of the last cycle, for the settings screen.
   */
  readonly awaiting = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly api: SyncApi,
    private readonly state: SyncStateStore,
    private readonly options: () => SyncOptions,
    /** Called once a confirmation from `adoptFolders` has been acted on. */
    private readonly onAdopted: (spaceId: string) => Promise<void> = async () => undefined,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  /**
   * One cycle over every selected space.
   *
   * A space that fails does not stop the others: the failure is recorded and
   * the next space is visited. The state file is written once at the end, so a
   * cycle interrupted halfway leaves the previous record intact and the pages
   * it had already written look locally edited on the next run — which the
   * conflict rule handles rather than silently overwriting.
   */
  async run(): Promise<SyncReport> {
    if (this.running) throw new Error(t.syncAlreadyRunning);
    this.running = true;
    const report = emptyReport();
    try {
      const options = this.options();
      const wanted = new Set(options.spaceIds);
      if (wanted.size === 0) return report;

      const spaces = (await this.api.listSpaces()).filter((space) => wanted.has(space.spaceId));
      for (const spaceId of wanted) {
        if (!spaces.some((space) => space.spaceId === spaceId)) {
          report.failures.push(t.spaceUnreadable(spaceId));
        }
      }

      await this.state.ensureLoaded();
      const deleting = new Set(options.deleteSpaceIds);
      const folders = planSpaceFolders(spaces);
      for (const space of spaces) {
        try {
          const visited = await this.syncSpace(
            space,
            folders.get(space.spaceId) ?? space.spaceId,
            deleting.has(space.spaceId),
            options.adoptFolders[space.spaceId],
            report,
          );
          if (visited) report.spaces += 1;
        } catch (error: unknown) {
          report.failures.push(`${space.name}: ${describe(error)}`);
        }
      }
      this.awaiting.clear();
      for (const paused of report.paused) this.awaiting.set(paused.spaceId, paused.folder);
      await this.state.save();
      return report;
    } finally {
      this.running = false;
      this.last = { at: Date.now(), report };
    }
  }

  /**
   * Send, then fetch.
   *
   * The second snapshot is taken only when something was sent, and it is what
   * makes the two halves agree: the plan the pull half places pages by is
   * computed from a picture of the Wiki that already includes this cycle's own
   * writes. Placing them from the older picture would move a page the push half
   * had just renamed straight back to its old name.
   *
   * Returns false for a space left alone this cycle (`claimFolder`).
   */
  private async syncSpace(
    space: SpaceSummary,
    folder: string,
    reflectDeletes: boolean,
    adopt: string | undefined,
    report: SyncReport,
  ): Promise<boolean> {
    const known = await this.claimFolder(space, folder, adopt, report);
    if (known === null) return false;
    let nodes = await this.api.listAllNodes(space.spaceId);
    let plan = planNodes(folder, nodes);

    if (known.linksChecked !== true) {
      await this.recheckLinks(folder, nodes, known);
      known.linksChecked = true;
    }

    const sent = await pushSpace(this.app, this.api, {
      space,
      folder: known.folder,
      nodes,
      plan,
      known,
      reflectDeletes,
      report,
    });
    if (sent) {
      nodes = await this.api.listAllNodes(space.spaceId);
      plan = planNodes(folder, nodes);
    }

    await this.pullSpace(folder, nodes, plan, known, report);
    return true;
  }

  /**
   * The space's record, with its folder where the plan says — or null when the
   * space is to be left alone this cycle.
   *
   * The push half reads every note under the folder it is given and sends what
   * the Wiki does not have, so the folder has to be the one this plugin wrote
   * for this space and nothing else. The folder name comes from the space's
   * name, which any admin of the space can change, so a name alone never makes
   * a folder the space's:
   *
   * - A renamed space has its recorded folder moved to the new name *before*
   *   anything is sent. If a folder of the new name already exists, it is some
   *   other folder — the user's own, or another space's — and the space is
   *   skipped and reported rather than sending that folder's notes. The same
   *   when the recorded folder has gone missing and the record says something
   *   was written there.
   * - A space with no record (seen for the first time, or after the record was
   *   cleared) whose folder already exists and holds something is paused until
   *   the user confirms importing that very folder in the settings. An empty
   *   or absent folder needs no confirmation: there is nothing in it to send.
   *
   * Names are compared without regard to case when deciding whether the
   * destination is taken. On a case-insensitive disk `Journal` and `journal`
   * are one folder, and writing the space into the second would put its notes
   * among the first's — so a folder that differs from the space's name in case
   * alone counts as taken, and is never imported.
   */
  private async claimFolder(
    space: SpaceSummary,
    folder: string,
    adopt: string | undefined,
    report: SyncReport,
  ): Promise<SpaceState | null> {
    let known = this.state.get(space.spaceId);

    if (known !== undefined && known.folder !== folder) {
      const source = this.app.vault.getAbstractFileByPath(known.folder);
      const wrote = Object.keys(known.pages).length + Object.keys(known.folders).length > 0;
      if (!(source instanceof TFolder)) {
        if (wrote) throw new Error(t.spaceFolderMissing(known.folder, folder));
        // Nothing was ever written for this record, so there is nothing to
        // follow; the space starts over as if it had never been seen.
        this.state.forget(space.spaceId);
        known = undefined;
      } else {
        // The recorded folder itself is the one match allowed: a rename that
        // changes only the case of the space's name moves it onto itself.
        const taken = this.sameNameAtTop(folder).filter((path) => path !== known?.folder);
        if (taken.length > 0) {
          throw new Error(t.spaceFolderTaken(known.folder, taken[0]));
        }
        // The pictures live inside the space's folder, so renaming it carries
        // them along with the notes — the recorded paths follow, and every link
        // between the two keeps counting the same number of folders.
        if (!(await this.moveFolder(known.folder, folder, known, true))) {
          throw new Error(t.spaceFolderMissing(known.folder, folder));
        }
        known.folder = folder;
        // Written now rather than at the end of the cycle. A cycle that stops
        // after the move would otherwise leave a record naming the old folder,
        // which no longer exists, and the space would be stuck on that.
        await this.state.save();
      }
    }

    if (known === undefined) {
      const clash = this.sameNameAtTop(folder).find((path) => path !== folder);
      if (clash !== undefined) throw new Error(t.spaceFolderCaseClash(clash, folder));
      const existing = this.app.vault.getAbstractFileByPath(folder);
      const occupied = existing instanceof TFolder && existing.children.length > 0;
      if (occupied && adopt !== folder) {
        report.paused.push({ spaceId: space.spaceId, name: space.name, folder });
        return null;
      }
      known = this.state.forSpace(space.spaceId, folder);
      if (adopt !== undefined) await this.onAdopted(space.spaceId);
    }
    return known;
  }

  /** Top-level entries whose name is `name` once case is ignored. */
  private sameNameAtTop(name: string): string[] {
    const lower = name.toLowerCase();
    return this.app.vault
      .getRoot()
      .children.filter((child) => child.path.toLowerCase() === lower)
      .map((child) => child.path);
  }

  /**
   * Make plain links of the picture links an earlier version let through from
   * the Wiki's text, before the push half reads the notes.
   *
   * That version disarmed `![](x)` but not `!![](x)`, which it turned into a
   * working `![](x)`. A note written that way keeps the link until the Wiki's
   * copy of the page changes, and the push half uploads whatever vault file the
   * link resolves to as soon as the user edits the note. So the notes of a
   * record from that version are checked once:
   *
   * - A note still exactly as the plugin wrote it holds the Wiki's text, and
   *   any picture link in it that is not one of the page's own attachments is
   *   made a plain link — what this version writes for the same body.
   * - A note the user has edited is sent only while the Wiki's copy is the one
   *   it was written from, so that copy is fetched and only the links taken
   *   from it are made plain. The user's own pictures keep uploading. One
   *   request per edited note, and only on this one cycle.
   *
   * - A conflict copy is never sent, but the user may rename one back into
   *   place, and the text in it is an earlier body of the same page. The links
   *   the Wiki's current copy of that page plants are made plain there too.
   *
   * Anything that cannot be checked stops the space for this cycle, before
   * anything is sent, and the check runs again on the next one.
   */
  private async recheckLinks(folder: string, nodes: RemoteNode[], known: SpaceState): Promise<void> {
    const remote = new Map(nodes.map((node) => [node.pageId, node]));
    const bodies = new Map<string, Promise<string | undefined>>();
    const wikiBody = (pageId: string): Promise<string | undefined> => {
      let body = bodies.get(pageId);
      if (body === undefined) {
        body = this.api.getPage(pageId).then((detail) => detail.body);
        bodies.set(pageId, body);
      }
      return body;
    };

    for (const [pageId, entry] of Object.entries(known.pages)) {
      const node = remote.get(pageId);
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      // A page the Wiki no longer has is trashed by the pull half, not sent.
      if (node === undefined || !(file instanceof TFile)) continue;
      const current = await this.app.vault.read(file);

      if ((await contentHash(current)) === entry.hash) {
        const checked = disarmWritten(
          this.contextFor(folder, pageId),
          current,
          entry.path,
          entry.attachments ?? {},
          entry.rendered ?? entry.path,
        );
        if (checked === null) throw new Error(`${entry.path}: ${t.unsafePictureLinks}`);
        if (checked !== current) {
          await this.app.vault.modify(file, checked);
          entry.hash = await contentHash(checked);
        }
        continue;
      }

      // Edited, but the Wiki has moved on: the push half does not send this
      // body, and the pull half sets it aside as a conflict copy, which is
      // never sent either.
      if (stampOf(node) !== entry.stamp) continue;
      const body = await wikiBody(pageId);
      if (body === undefined) continue;
      const targets = wikiTargets(body);
      if (targets.size === 0) continue;
      const checked = disarmTargets(current, targets);
      if (checked === null) throw new Error(`${entry.path}: ${t.unsafePictureLinks}`);
      // The recorded hash is left as it was: the note is still an edit to send.
      if (checked !== current) await this.app.vault.modify(file, checked);
    }

    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return;
    const pageAt = new Map(Object.entries(known.pages).map(([pageId, entry]) => [entry.path, pageId]));
    const copies: TFile[] = [];
    const walk = (dir: TFolder): void => {
      for (const child of dir.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && isQuarantinePath(child.path)) copies.push(child);
      }
    };
    walk(root);
    for (const copy of copies) {
      const pageId = pageAt.get(quarantineOrigin(copy.path));
      if (pageId === undefined || !remote.has(pageId)) continue;
      const body = await wikiBody(pageId);
      if (body === undefined) continue;
      const targets = wikiTargets(body);
      if (targets.size === 0) continue;
      const current = await this.app.vault.read(copy);
      const checked = disarmTargets(current, targets);
      if (checked === null) throw new Error(`${copy.path}: ${t.unsafePictureLinks}`);
      if (checked !== current) await this.app.vault.modify(copy, checked);
    }
  }

  /**
   * ─── The order within one space ───────────────────────────────────────────
   * The space's own folder has already been put under its current name
   * (`claimFolder`), before the push half ran. Then:
   * 1. trash the notes the Wiki no longer has, deepest first
   * 2. place the folders — rename what moved, create what is new, parents first
   * 3. move the notes that belong elsewhere
   * 4. fetch the bodies that changed
   * 5. remove the folders the Wiki no longer has, deepest first and only when
   *    they are empty
   *
   * Folders are placed before the notes are moved so that a note's destination
   * exists and is already under its final name — and a folder rename carries
   * every descendant with it in one step, which leaves most notes already where
   * they belong by the time step 3 looks at them.
   *
   * A folder the Wiki dropped is removed last for the same reason read
   * backwards: whatever was inside it has by then been trashed (a cascading
   * delete) or moved out (a reparenting one), so the directory is empty and its
   * removal takes nothing with it. One that is *not* empty holds something the
   * user put there, and it stays.
   */
  private async pullSpace(
    folder: string,
    nodes: RemoteNode[],
    plan: Placement,
    known: SpaceState,
    report: SyncReport,
  ): Promise<void> {
    report.skipped += nodes.length - plan.nodes.size;
    await this.ensureFolder(folder);

    const removed = Object.keys(known.pages)
      .filter((pageId) => !plan.nodes.has(pageId))
      .sort((a, b) => depthOf(known.pages[b].path) - depthOf(known.pages[a].path));
    for (const pageId of removed) {
      const entry = known.pages[pageId];
      try {
        await this.trash(folder, pageId, entry);
        delete known.pages[pageId];
        report.removed += 1;
      } catch (error: unknown) {
        report.failures.push(`${entry.path}: ${describe(error)}`);
      }
    }

    const ordered = [...plan.nodes.values()].sort((left, right) => left.depth - right.depth);

    for (const planned of ordered) {
      if (planned.node.kind !== 'folder') continue;
      try {
        if (await this.placeFolder(planned, known)) report.moved += 1;
      } catch (error: unknown) {
        report.failures.push(`${planned.path}: ${describe(error)}`);
      }
    }

    for (const planned of ordered) {
      if (planned.node.kind !== 'page') continue;
      const entry = known.pages[planned.node.pageId];
      if (entry === undefined) continue;
      try {
        if (await this.relocate(entry, planned)) report.moved += 1;
      } catch (error: unknown) {
        report.failures.push(`${planned.path}: ${describe(error)}`);
      }
    }

    for (const planned of ordered) {
      if (planned.node.kind !== 'page') continue;
      try {
        await this.writeBody(folder, planned, known, report);
      } catch (error: unknown) {
        report.failures.push(`${planned.path}: ${describe(error)}`);
      }
    }

    const dropped = Object.keys(known.folders)
      .filter((folderId) => !plan.nodes.has(folderId))
      .sort((a, b) => depthOf(known.folders[b].path) - depthOf(known.folders[a].path));
    for (const folderId of dropped) {
      const entry = known.folders[folderId];
      try {
        // Only when empty. What the user left in it is theirs, and the record
        // goes either way: the node it named is gone, so there is nothing left
        // for it to point at.
        if (await this.removeIfEmpty(entry.path)) report.removed += 1;
        delete known.folders[folderId];
      } catch (error: unknown) {
        report.failures.push(`${entry.path}: ${describe(error)}`);
      }
    }
  }

  /**
   * Put one folder where the plan says it goes, making it if it is not there.
   *
   * Returns whether anything on disk actually moved. A folder the record has
   * never heard of is the ordinary case twice over: on the first cycle of a
   * space, and on the first cycle after the migration turned pages
   * with children into folders. Both are answered by `ensureFolder`, which
   * adopts a directory that is already there rather than insisting on making
   * one — so the migration moves nothing in the vault.
   */
  private async placeFolder(planned: PlannedNode, known: SpaceState): Promise<boolean> {
    const folderId = planned.node.pageId;
    const entry = known.folders[folderId];
    let moved = false;

    if (entry === undefined) {
      await this.ensureFolder(planned.path);
      known.folders[folderId] = { path: planned.path, syncedPath: planned.path };
      return false;
    }

    if (entry.path !== planned.path) {
      // Moving the directory takes its descendants with it and rewrites their
      // recorded paths; when it is not there to move, one is made and the
      // descendants are written into it as each is reached.
      moved = await this.moveFolder(entry.path, planned.path, known);
      if (!moved) await this.ensureFolder(planned.path);
      entry.path = planned.path;
    } else {
      await this.ensureFolder(planned.path);
    }

    // Set whether or not anything moved, for the reason a note's is: this is
    // where the plugin has put the folder, and it is what the next cycle
    // measures a local move against. One carried here by an ancestor never
    // enters the branch above.
    entry.syncedPath = planned.path;
    return moved;
  }

  /**
   * Put one page's note where the plan says it goes.
   *
   * Returns whether anything on disk actually moved, which is not the same as
   * whether the recorded path changed: a note whose ancestor folder was renamed
   * a moment ago is already in its new place.
   */
  private async relocate(entry: PageState, planned: PlannedNode): Promise<boolean> {
    let moved = false;
    if (entry.path !== planned.path) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile) {
        await this.ensureFolder(dirname(planned.path));
        await this.app.vault.rename(file, planned.path);
        moved = true;
      }
      entry.path = planned.path;
    }
    entry.syncedPath = planned.path;
    return moved;
  }

  private async writeBody(
    folder: string,
    planned: PlannedNode,
    known: SpaceState,
    report: SyncReport,
  ): Promise<void> {
    const pageId = planned.node.pageId;
    const entry = known.pages[pageId];
    const existing = this.app.vault.getAbstractFileByPath(planned.path);
    const present = existing instanceof TFile;

    // The snapshot already answers this for most pages, and answering it here
    // costs no round trip at all. It only answers it while the note is actually
    // there: a page deleted locally is restored by the next fetch unless the
    // space is one where a deletion is sent to the Wiki instead (`push.ts`).
    if (present && entry !== undefined && entry.stamp === stampOf(planned.node)) {
      await this.refreshLinks(folder, planned, entry, existing, report);
      report.unchanged += 1;
      return;
    }

    // The stamp is only offered when the body it names is on disk. Offering it
    // for a missing note would be answered with `unchanged` and no body — the
    // one case where the server is right and the vault is still empty.
    const detail = await this.api.getPage(pageId, present ? entry?.stamp : undefined);
    // Taken from this answer and not from the snapshot: the page may have been
    // written again between the two calls, and recording the older mark would
    // leave the vault holding a body it believes is current. It is also how a
    // page the push half just wrote gets a mark at all — that half blanks it
    // rather than guessing what the Wiki assigned.
    const stamp = stampOf(detail);
    if (detail.body === undefined) {
      if (entry !== undefined) {
        entry.stamp = stamp;
        if (present) await this.refreshLinks(folder, planned, entry, existing, report);
      }
      report.unchanged += 1;
      return;
    }

    // The Wiki's body names its pictures by id; the vault's names them by where
    // they sit on disk. Everything the note needs is fetched here, and what the
    // links are turned into is the same file the next push turns back into ids.
    const rendered = await toVaultBody(
      this.contextFor(folder, pageId),
      detail.body,
      planned.path,
      entry?.attachments ?? {},
      planned.path,
      // The Wiki's own text, so its picture links are read for the attachments
      // they name and nothing else — see `disarm` in `attachments.ts`.
      'wiki',
    );
    report.downloaded += rendered.fetched;
    for (const failure of rendered.failures) report.failures.push(`${planned.path}: ${failure}`);

    const record = (hash: string): void => {
      known.pages[pageId] = {
        path: planned.path,
        syncedPath: planned.path,
        stamp,
        hash,
        // Only carried by a body that shows pictures, which most do not. A body
        // still owed one counts: without these two the repair below has nothing
        // to work from, and the note would keep a broken link for as long as
        // the Wiki's own copy of the body stayed as it is.
        ...(Object.keys(rendered.files).length === 0 && rendered.pending.length === 0
          ? {}
          : { attachments: rendered.files, rendered: planned.path }),
        ...(rendered.pending.length === 0 ? {} : { pending: rendered.pending }),
      };
    };

    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === rendered.body) {
        // Same text, no record of having written it — which is what every note
        // looks like after the sync record is discarded, and what a page the
        // push half just sent looks like when it comes back unchanged. Nothing
        // to write and nothing to set aside; only the record is missing.
        record(await contentHash(current));
        report.unchanged += 1;
        return;
      }
      // Either the user edited the note since it was written, or the file was
      // never written by this plugin at all. Both are content the Wiki does not
      // have, and both are set aside instead of being lost (the Wiki keeps its
      // own losing revisions, but nothing keeps these).
      if (entry === undefined || (await contentHash(current)) !== entry.hash) {
        await this.quarantine(planned.path, current);
        report.conflicts += 1;
      }
      await this.app.vault.modify(existing, rendered.body);
    } else {
      await this.ensureFolder(dirname(planned.path));
      await this.app.vault.create(planned.path, rendered.body);
    }

    record(await contentHash(rendered.body));
    report.fetched += 1;
  }

  /**
   * Point a note's picture links back at the pictures, when they have drifted.
   *
   * Three things break links in a body nobody edited. The note moved, so the
   * `../` in front of every link counts the wrong number of folders; a file
   * they point at is gone, deleted from the vault after it was written; or a
   * picture never arrived in the first place, because the download failed while
   * the body around it was written anyway. All three are noticed without
   * reading anything from disk, and none costs a round trip while nothing is
   * wrong — which is the ordinary case for every page in a space that is
   * already mirrored.
   *
   * The third is the one that lasts. The first two follow something the user
   * just did and are repaired within a cycle of it; a download that failed
   * leaves a body the Wiki considers delivered, so nothing else would ever ask
   * for the picture again. `pending` is what keeps asking.
   *
   * The body is read as it stands rather than fetched again. The Wiki has
   * nothing new to say about a page whose mark still matches; what changed is
   * on this side.
   */
  private async refreshLinks(
    folder: string,
    planned: PlannedNode,
    entry: PageState,
    file: TFile,
    report: SyncReport,
  ): Promise<void> {
    const owed = entry.pending ?? [];
    if (entry.attachments === undefined && owed.length === 0) return;
    const placed = entry.rendered === planned.path;
    const intact = Object.values(entry.attachments ?? {}).every(
      (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
    );
    if (placed && intact && owed.length === 0) return;

    const current = await this.app.vault.read(file);
    const rendered = await toVaultBody(
      this.contextFor(folder, planned.node.pageId),
      current,
      planned.path,
      entry.attachments ?? {},
      // Where the links in this body were written to be read from, which is
      // where the note used to be. Reading them from anywhere else would find
      // no file, and a link that resolves to nothing cannot be repaired.
      entry.rendered ?? planned.path,
    );
    report.downloaded += rendered.fetched;
    for (const failure of rendered.failures) report.failures.push(`${planned.path}: ${failure}`);

    if (rendered.body !== current) {
      await this.app.vault.modify(file, rendered.body);
      entry.hash = await contentHash(rendered.body);
    }
    entry.attachments = rendered.files;
    entry.rendered = planned.path;
    // Cleared rather than left at zero length, so a record that is owed nothing
    // reads the same whether or not it ever was.
    if (rendered.pending.length === 0) delete entry.pending;
    else entry.pending = rendered.pending;
  }

  private contextFor(folder: string, pageId: string): AttachmentContext {
    return { app: this.app, api: this.api, spaceFolder: folder, pageId };
  }

  /**
   * Rename a folder and follow it in the record.
   *
   * `vault.rename` and not `fileManager.renameFile`: the latter rewrites links
   * in other notes to keep them pointing at the moved file, and every note it
   * rewrote would then differ from the body the Wiki holds — a move in the Wiki
   * would manufacture conflicts in notes that nobody touched.
   *
   * `carriesAttachments` says whether the pictures moved too, which is true of
   * the space's own folder and of nothing inside it. When they did, the links
   * between notes and pictures are still correct and the record says so; when
   * they did not, `rendered` is deliberately left naming the old place, and
   * that gap is what has `refreshLinks` write the links again.
   */
  private async moveFolder(
    from: string,
    to: string,
    known: SpaceState,
    carriesAttachments = false,
  ): Promise<boolean> {
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) return false;
    await this.ensureFolder(dirname(to));
    await this.app.vault.rename(folder, to);
    const follow = (path: string): string | null =>
      path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
    for (const entry of Object.values(known.folders)) {
      entry.path = follow(entry.path) ?? entry.path;
      // The plugin moved these, so the place it put them moves with them.
      entry.syncedPath = follow(entry.syncedPath) ?? entry.syncedPath;
    }
    for (const entry of Object.values(known.pages)) {
      entry.path = follow(entry.path) ?? entry.path;
      entry.syncedPath = follow(entry.syncedPath) ?? entry.syncedPath;
      if (!carriesAttachments || entry.attachments === undefined) continue;
      if (entry.rendered !== undefined) entry.rendered = follow(entry.rendered) ?? entry.rendered;
      for (const [id, path] of Object.entries(entry.attachments)) {
        entry.attachments[id] = follow(path) ?? path;
      }
    }
    return true;
  }

  /** Keep the local version under a name of its own, in the same folder. */
  private async quarantine(path: string, content: string): Promise<void> {
    const now = new Date();
    for (let attempt = 0; ; attempt += 1) {
      const candidate = quarantinePath(path, now, attempt);
      if (this.app.vault.getAbstractFileByPath(candidate) === null) {
        await this.app.vault.create(candidate, content);
        return;
      }
    }
  }

  private async trash(folder: string, pageId: string, entry: PageState): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    // `false` is the vault's own `.trash`, not the operating system's. A page
    // deleted in the Wiki is recoverable there for as long as the user keeps it.
    if (file instanceof TFile) await this.app.vault.trash(file, false);

    // The pictures the plugin downloaded for this page go with it. Only that
    // folder: a picture the user pasted stays where they put it, and it may
    // well be embedded in a note this deletion has nothing to do with.
    const pictures = this.app.vault.getAbstractFileByPath(attachmentFolder(folder, pageId));
    if (pictures instanceof TFolder) await this.app.vault.trash(pictures, false);
    await this.removeIfEmpty(`${folder}/${ATTACHMENT_DIR}`);
  }

  /** Trash a folder if nothing is left in it; says whether it did. */
  private async removeIfEmpty(path: string): Promise<boolean> {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder) || folder.children.length > 0) return false;
    await this.app.vault.trash(folder, false);
    return true;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (path === '') return;
    let walked = '';
    for (const segment of path.split('/')) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(walked) !== null) continue;
      try {
        await this.app.vault.createFolder(walked);
      } catch (error: unknown) {
        // Another cycle, or Obsidian itself, may have created it in between.
        if (this.app.vault.getAbstractFileByPath(walked) === null) throw error;
      }
    }
  }
}

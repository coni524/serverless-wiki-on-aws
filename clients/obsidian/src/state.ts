/**
 * The sync state file: which node is which file or folder, and what was last
 * written.
 *
 * It lives next to the settings, at
 * `<vault>/.obsidian/plugins/slwiki-sync/sync-state.json`, but not inside them.
 * `data.json` holds the refresh token and is rewritten by `saveSettings()`;
 * this file is rewritten at the end of every sync cycle and grows with the
 * number of pages. Keeping them apart means a sync cycle never rewrites the
 * tokens, and a corrupt state file never costs the user their sign-in.
 *
 * Losing this file is recoverable by design:
 * with no record of what was written, every page looks new and the next cycle
 * fetches the space in full. So anything unreadable here is discarded rather
 * than repaired.
 */
import type { DataAdapter } from 'obsidian';

/** What was last written to the vault for one page. */
export type PageState = {
  /**
   * Where the note is now.
   *
   * Written by the plugin when it places a page, and moved from under it by
   * `trackRename` when the user renames or drags the note in Obsidian. So this
   * is the file the next cycle reads, wherever the user has since put it.
   */
  path: string;
  /**
   * Where the plugin itself last put the note.
   *
   * The difference between this and `path` is the whole of what "the user moved
   * or renamed it" means, and the difference between this and the path the
   * current snapshot calls for is what "the Wiki renamed or moved it" means.
   * Comparing the two against the same third value is what keeps a move from
   * being read as a move in the opposite direction (`push.ts`).
   */
  syncedPath: string;
  /** The freshness mark of the body on disk (`stampOf`). */
  stamp: string;
  /** Hash of the body as written, which is how a local edit is noticed. */
  hash: string;
  /**
   * Each attachment the body shows, and the vault file holding it.
   *
   * Absent for a body with no pictures in it, which is most of them. It cannot
   * be derived from where the files sit: one downloaded by the plugin lands in
   * the page's own folder, while one the user pasted keeps the place Obsidian
   * put it — the plugin uploads it and remembers where it is rather than moving
   * a file that another note may embed too (`attachments.ts`).
   */
  attachments?: Record<string, string>;
  /**
   * The note path the picture links were written against.
   *
   * Links are relative to the note, so a note that moves carries a body whose
   * `../` no longer counts the right number of folders. The difference between
   * this and where the note now is, is what tells the next cycle to write them
   * again — and it survives a cycle that stopped halfway, which a flag held in
   * memory would not.
   */
  rendered?: string;
  /**
   * Attachments this body names that are not on disk yet.
   *
   * A body is fetched once and then left alone for as long as the Wiki's mark
   * stays put, so a picture whose download failed would keep its dangling link
   * until somebody edited the page — the one thing that will not happen to a
   * page nobody is working on. This is the note that the body is owed
   * something, and it is what has the next cycle ask again (`sync.ts`).
   *
   * Absent once every picture has arrived, which is the ordinary case.
   */
  pending?: string[];
};

/**
 * What was last written to the vault for one folder.
 *
 * A folder has no body and no attachments, so the record is nothing but the two
 * paths — which is also the whole of what a folder can differ in. The pair
 * means what it means for a page: `path` is where the directory is now, and
 * `syncedPath` is where the plugin put it, so the gap between them is the user
 * having renamed or moved it.
 */
export type FolderState = {
  path: string;
  syncedPath: string;
};

export type SpaceState = {
  /** The space's folder in the vault, so a renamed space can be followed. */
  folder: string;
  pages: Record<string, PageState>;
  folders: Record<string, FolderState>;
};

type SyncState = {
  version: 2;
  spaces: Record<string, SpaceState>;
};

const EMPTY: SyncState = { version: 2, spaces: {} };

export class SyncStateStore {
  private state: SyncState = structuredClone(EMPTY);
  private loaded = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly pluginDir: string,
  ) {}

  private get path(): string {
    return `${this.pluginDir}/sync-state.json`;
  }

  /**
   * Read the file once and keep it.
   *
   * It is not re-read at the start of every cycle, because between cycles this
   * record also moves: a rename in the vault reaches `trackRename` and nothing
   * else knows about it. Re-reading would discard exactly the changes that were
   * made while no cycle was running.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
  }

  async load(): Promise<void> {
    this.state = structuredClone(EMPTY);
    this.loaded = true;
    if (!(await this.adapter.exists(this.path))) return;
    try {
      const parsed = JSON.parse(await this.adapter.read(this.path)) as SyncState;
      const version: number = parsed.version;
      const known = version === 1 || version === 2;
      if (known && typeof parsed.spaces === 'object' && parsed.spaces !== null) {
        this.state = { version: 2, spaces: parsed.spaces };
        this.repair();
      }
    } catch {
      // Unreadable state is the same as no state: the next cycle fetches
      // everything. Saying so is the settings screen's job, not this one's.
    }
  }

  /**
   * Fill in what a record written by an earlier version does not carry.
   *
   * A file from the fetch-only plugin has no `syncedPath`, and reading its
   * absence as an empty string would make every page look like the user had
   * moved it — the first cycle after an upgrade would push the whole space back
   * as renames. Taking the current path instead says "nothing has moved since
   * the plugin put it there", which is true: that version tracked no local
   * moves at all.
   *
   * A file from before folders has no `folders` map and carries a
   * `folder` on every page, naming the directory a page with children owned.
   * Both are dropped rather than translated: the folders of that vault stand
   * for no node yet, and the ones the migration creates in the Wiki land on the
   * very directories that are already there — a page written as `X/X.md` by the
   * old rule is a page inside folder `X` under the new one, in the same place.
   * So the first cycle after the migration adopts each existing directory as it
   * meets the folder it stands for, and nothing on disk moves.
   */
  private repair(): void {
    for (const space of Object.values(this.state.spaces)) {
      if (typeof space.folders !== 'object' || space.folders === null) space.folders = {};
      for (const entry of Object.values(space.pages ?? {})) {
        if (typeof entry.syncedPath !== 'string' || entry.syncedPath === '') {
          entry.syncedPath = entry.path;
        }
        delete (entry as { folder?: unknown }).folder;
      }
    }
  }

  /**
   * Follow a rename or a move the user made in the vault.
   *
   * Obsidian reports one event for the top of what moved, so a folder carries
   * everything under it and each record below has its own path rewritten here.
   * `syncedPath` is deliberately left where it was: it names the place the
   * plugin put the note, and the gap that has just opened between the two is
   * what the next cycle sends to the Wiki.
   */
  trackRename(from: string, to: string): boolean {
    const moved = (path: string): string | null =>
      path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;

    let touched = false;
    for (const space of Object.values(this.state.spaces)) {
      const folder = moved(space.folder);
      if (folder !== null) {
        space.folder = folder;
        touched = true;
      }
      // Both kinds, and the same rule for each: a folder the user renames is
      // reported once, and every record below it — notes and folders alike —
      // has its own path rewritten here.
      const records = [...Object.values(space.pages ?? {}), ...Object.values(space.folders ?? {})];
      for (const entry of records) {
        const path = moved(entry.path);
        if (path !== null) {
          entry.path = path;
          touched = true;
        }
      }
    }
    return touched;
  }

  async save(): Promise<void> {
    await this.adapter.write(this.path, JSON.stringify(this.state, null, 2));
  }

  /** The record for a space, created on first use with the folder it is given. */
  forSpace(spaceId: string, folder: string): SpaceState {
    const existing = this.state.spaces[spaceId];
    if (existing !== undefined) return existing;
    const created: SpaceState = { folder, pages: {}, folders: {} };
    this.state.spaces[spaceId] = created;
    return created;
  }

  /** Every space this store remembers, whether or not it is still synced. */
  spaceIds(): string[] {
    return Object.keys(this.state.spaces);
  }

  /**
   * Forget a space, or all of them.
   *
   * The files stay where they are. What goes is the memory of having written
   * them, which makes the next cycle treat each one as a local file it did not
   * write — so a page whose body differs is preserved as a conflict copy rather
   * than overwritten.
   */
  forget(spaceId?: string): void {
    if (spaceId === undefined) this.state = structuredClone(EMPTY);
    else delete this.state.spaces[spaceId];
  }
}

/**
 * The hash recorded for a body, and recomputed to notice a local edit.
 *
 * Half of a SHA-256 is kept. The comparison is against a value this plugin
 * wrote itself minutes earlier, so what matters is that unrelated bodies do not
 * collide, and 128 bits settles that with room to spare.
 */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

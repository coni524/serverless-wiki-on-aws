/**
 * Where a node lands in the vault.
 *
 * The whole mapping is computed from one snapshot of a space, with no reference
 * to what is already on disk. That is deliberate: the same input always yields
 * the same paths, so the sync engine can compare "where this node should be"
 * against "where this node was last written" and treat the difference as a move.
 *
 * The two trees have the same two kinds of node, so the mapping is
 * the identity on shape:
 *   - a page is `<title>.md`
 *   - a folder is `<title>/`
 *
 * Nothing is invented on either side. A folder holding no notes is still a
 * folder in the Wiki, and a page is a leaf in both places.
 */

/** A node as `listPages` returns it — no body, just what placement needs. */
export type RemoteNode = {
  pageId: string;
  kind: 'page' | 'folder';
  parentPageId: string | null;
  title: string;
  revision: number;
  updatedAt?: string;
};

export type PlannedNode = {
  node: RemoteNode;
  /** Vault-relative path: the note for a page, the folder itself for a folder. */
  path: string;
  /** Distance from the space folder. Parents sort before their children. */
  depth: number;
};

/**
 * Where every node of a space goes, and which vault folder holds whose children.
 *
 * `containers` is the second half because a folder is not the only thing that
 * can own a directory. A page that still has children — one the migration
 * has not reached yet — keeps them in a directory named after it,
 * beside its own note. Both halves of the cycle need to know that such a
 * directory stands for a node that already exists: without it the push half
 * would read it as a folder the user made and create a second node for it.
 */
export type Placement = {
  nodes: Map<string, PlannedNode>;
  /** Vault folder → the id of the node whose children it holds. */
  containers: Map<string, string>;
};

/**
 * How the client names the body it holds.
 *
 * Must match `bodyStamp()` in `aws-blocks/wiki-ops.ts` character for character:
 * the server compares the string, not its parts.
 */
export const stampOf = (page: { revision: number; updatedAt?: string }): string =>
  `${page.revision}@${page.updatedAt ?? ''}`;

/**
 * The folder holding the pictures a space's bodies show (`attachments.ts`).
 *
 * It sits directly under the space's folder, which makes it a sibling of that
 * space's top-level folders — so it is reserved among them, and a folder
 * actually named `_attachments` is pushed aside rather than being written over
 * the pictures. A *page* by that name is unaffected: its note is
 * `_attachments.md`, which nothing else claims.
 */
export const ATTACHMENT_DIR = '_attachments';

/** The parent key standing for "directly under the space". */
const ROOT = '\0root';

/**
 * Lay a space's nodes out under `rootFolder`.
 *
 * Nodes unreachable from the root are left out of the result. Two things can
 * make a node unreachable: a parent that is not in the snapshot, which is
 * handled by treating the node as a root, and a parent cycle, which the Wiki
 * forbids (`movePage`) and which this cannot repair. The caller reports the
 * difference between the snapshot's size and this map's size, so an unreachable
 * node is visible rather than silently missing from the mirror.
 *
 * Names are made unique within a directory, but per kind: a note and a
 * directory of the same name are two different paths, so `X.md` beside `X/` is
 * simply what a page and a folder sharing a title look like.
 */
export function planNodes(rootFolder: string, nodes: RemoteNode[]): Placement {
  const known = new Set(nodes.map((node) => node.pageId));
  const byParent = new Map<string, RemoteNode[]>();
  for (const node of nodes) {
    const parent =
      node.parentPageId !== null && known.has(node.parentPageId) ? node.parentPageId : ROOT;
    const siblings = byParent.get(parent);
    if (siblings === undefined) byParent.set(parent, [node]);
    else siblings.push(node);
  }

  const planned = new Map<string, PlannedNode>();
  const containers = new Map<string, string>();
  const walk = (parent: string, dir: string, reserved: string | null, depth: number): void => {
    const children = byParent.get(parent) ?? [];
    // A folder owns a directory, and so does a page the migration
    // has not reached yet: its children have to sit somewhere, and beside its
    // own note is where they already are — the folder note `X/X.md` this
    // replaces put the note inside that same directory. Those two compete for
    // one name; notes compete for the other.
    const dirNames = uniqueNames(
      children.filter((node) => node.kind === 'folder' || byParent.has(node.pageId)),
      reserved,
    );
    const noteNames = uniqueNames(
      children.filter((node) => node.kind === 'page'),
      null,
    );

    for (const node of children) {
      const home = dirNames.get(node.pageId);
      if (node.kind === 'folder') {
        planned.set(node.pageId, { node, path: `${dir}/${home ?? node.pageId}`, depth });
      } else {
        const name = noteNames.get(node.pageId) ?? node.pageId;
        planned.set(node.pageId, { node, path: `${dir}/${name}.md`, depth });
      }
      if (home === undefined) continue;
      containers.set(`${dir}/${home}`, node.pageId);
      if (byParent.has(node.pageId)) walk(node.pageId, `${dir}/${home}`, null, depth + 1);
    }
  };
  walk(ROOT, rootFolder, ATTACHMENT_DIR, 0);
  return { nodes: planned, containers };
}

/**
 * One folder per space, directly under the vault root.
 *
 * Space names are not unique in the Wiki, so the same collision rule as for
 * sibling pages applies here.
 */
export function planSpaceFolders(
  spaces: { spaceId: string; name: string }[],
): Map<string, string> {
  return uniqueNames(
    spaces.map((space) => ({ pageId: space.spaceId, title: space.name })),
    null,
  );
}

/**
 * Name each item so that no two collide, and none collides with `reserved`.
 *
 * `reserved` is a name the directory already spends on something that is not a
 * node of the tree. There is one: `_attachments` directly under a space, the
 * folder holding the pictures.
 *
 * When names do collide, every member of the collision gets the suffix rather
 * than all but one. Which page would have kept the plain name otherwise depends
 * on the order the query returned them, and a name that moves between sync
 * cycles is a rename in the vault.
 */
function uniqueNames(
  items: { pageId: string; title: string }[],
  reserved: string | null,
): Map<string, string> {
  const counts = new Map<string, number>();
  if (reserved !== null) counts.set(reserved.toLowerCase(), 1);
  const bases = new Map<string, string>();
  for (const item of items) {
    const base = fileNameFromTitle(item.title);
    bases.set(item.pageId, base);
    counts.set(base.toLowerCase(), (counts.get(base.toLowerCase()) ?? 0) + 1);
  }

  const named = new Map<string, string>();
  for (const item of items) {
    const base = bases.get(item.pageId) ?? '';
    const collides = (counts.get(base.toLowerCase()) ?? 0) > 1;
    named.set(item.pageId, collides ? `${base} (${item.pageId.slice(0, 8)})` : base);
  }
  return named;
}

/** Characters no major filesystem accepts, plus the ones Obsidian refuses. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Names Windows still reserves for devices, with or without an extension. */
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name that means the title and that the filesystem will accept.
 *
 * The 100-byte cap is on the segment, not the title. A path segment may be 255
 * bytes, but the Wiki allows 200 characters of title — 600 bytes in Japanese —
 * and ten of those may stack up in one path. Truncating here keeps deep trees
 * inside the limit; the collision rule above then separates any two titles that
 * were cut down to the same text.
 */
export function fileNameFromTitle(title: string): string {
  const cleaned = truncateBytes(title.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').trim(), 100)
    // Windows drops a trailing dot or space, which would leave the plugin
    // looking for a file under a name the filesystem quietly changed.
    .replace(/[.\s]+$/, '');
  // Deliberately not in the dictionary: this becomes a file name in the vault,
  // so translating it would rename existing files the moment the UI language
  // changed, and the record would no longer find them.
  if (cleaned === '') return 'Untitled';
  return DEVICE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
}

function truncateBytes(value: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= limit) return value;
  let kept = '';
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (used + size > limit) break;
    kept += character;
    used += size;
  }
  return kept.trimEnd();
}

/**
 * The name a local version is kept under when both sides had changed.
 *
 * Composed here, next to the pattern that recognises it again. The push half
 * has to leave these files alone: a conflict copy sits inside the space's
 * folder like any other note, and uploading it would put the losing text back
 * into the Wiki as a page of its own — the one thing setting it aside was
 * meant to avoid.
 */
export const quarantinePath = (path: string, at: Date, attempt: number): string => {
  const stem = basename(path).replace(/\.md$/, '');
  const when =
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ` +
    `${two(at.getHours())}${two(at.getMinutes())}`;
  const suffix = attempt === 0 ? '' : ` ${attempt + 1}`;
  const folder = dirname(path);
  const name = `${stem} (conflict ${when}${suffix}).md`;
  return folder === '' ? name : `${folder}/${name}`;
};

const QUARANTINE = /\s\(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)$/;

/** Whether a note is one this plugin set aside rather than one to send. */
export const isQuarantinePath = (path: string): boolean => QUARANTINE.test(stemOf(path));

const two = (value: number): string => String(value).padStart(2, '0');

/** A note's file name without its extension — the title as the user typed it. */
export const stemOf = (path: string): string => basename(path).replace(/\.md$/, '');

/**
 * The name with the collision suffix taken back off.
 *
 * A page whose title clashes with a sibling is written as `<title> (a1b2c3d4)`.
 * That suffix is the plugin's, not the user's, so renaming such a note has to
 * mean the part in front of it — otherwise the first rename of a clashing page
 * would write the disambiguator into the Wiki as part of the title.
 */
export const withoutIdSuffix = (name: string, pageId: string): string => {
  const suffix = ` (${pageId.slice(0, 8)})`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** How deep a path sits, used to delete children before their parents. */
export const depthOf = (path: string): number => path.split('/').length;

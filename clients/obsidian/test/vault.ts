/**
 * A vault held in memory.
 *
 * Paths are the whole of it: every file and folder is one entry in a map, and
 * `rename` rewrites the entries below the one it was given, which is what makes
 * a folder carry its contents the way Obsidian's own vault does.
 */
import { TAbstractFile, TFile, TFolder } from 'obsidian';

export class FakeVault {
  private readonly byPath = new Map<string, TAbstractFile>();
  private readonly bodies = new Map<string, string>();
  readonly trashed: string[] = [];
  readonly root: TFolder;

  constructor() {
    this.root = new TFolder();
    this.root.path = '/';
    this.byPath.set('/', this.root);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.byPath.get(path) ?? null;
  }

  private parentOf(path: string): TFolder {
    const cut = path.lastIndexOf('/');
    if (cut === -1) return this.root;
    const found = this.byPath.get(path.slice(0, cut));
    if (!(found instanceof TFolder)) throw new Error(`no folder for ${path}`);
    return found;
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.byPath.has(path)) throw new Error(`already exists: ${path}`);
    const folder = new TFolder();
    folder.path = path;
    const parent = this.parentOf(path);
    folder.parent = parent;
    parent.children.push(folder);
    this.byPath.set(path, folder);
    return folder;
  }

  async create(path: string, body: string): Promise<TFile> {
    if (this.byPath.has(path)) throw new Error(`already exists: ${path}`);
    const file = new TFile();
    file.path = path;
    const parent = this.parentOf(path);
    file.parent = parent;
    parent.children.push(file);
    this.byPath.set(path, file);
    this.bodies.set(path, body);
    return file;
  }

  async read(file: TFile): Promise<string> {
    return this.bodies.get(file.path) ?? '';
  }

  async modify(file: TFile, body: string): Promise<void> {
    this.bodies.set(file.path, body);
  }

  async rename(item: TAbstractFile, to: string): Promise<void> {
    if (this.byPath.has(to)) throw new Error(`already exists: ${to}`);
    const from = item.path;
    const moving = [...this.byPath.values()].filter(
      (node) => node.path === from || node.path.startsWith(`${from}/`),
    );
    const oldParent = item.parent;
    if (oldParent !== null) oldParent.children = oldParent.children.filter((c) => c !== item);
    for (const node of moving) {
      const next = to + node.path.slice(from.length);
      this.byPath.delete(node.path);
      const body = this.bodies.get(node.path);
      if (body !== undefined) {
        this.bodies.delete(node.path);
        this.bodies.set(next, body);
      }
      node.path = next;
      this.byPath.set(next, node);
    }
    const parent = this.parentOf(to);
    item.parent = parent;
    parent.children.push(item);
  }

  async trash(item: TAbstractFile, _system: boolean): Promise<void> {
    this.trashed.push(item.path);
    const going = [...this.byPath.values()].filter(
      (node) => node.path === item.path || node.path.startsWith(`${item.path}/`),
    );
    for (const node of going) {
      this.byPath.delete(node.path);
      this.bodies.delete(node.path);
    }
    if (item.parent !== null) item.parent.children = item.parent.children.filter((c) => c !== item);
  }

  // ─── For the tests themselves ─────────────────────────────────────────────

  /** Every path in the vault, folders marked with a trailing slash. */
  listing(): string[] {
    return [...this.byPath.values()]
      .filter((node) => node !== this.root)
      .map((node) => (node instanceof TFolder ? `${node.path}/` : node.path))
      .sort();
  }

  bodyOf(path: string): string | undefined {
    return this.bodies.get(path);
  }

  /** Make a folder and every folder above it, as the user would. */
  async userCreateFolder(path: string): Promise<void> {
    let walked = '';
    for (const segment of path.split('/')) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      if (!this.byPath.has(walked)) await this.createFolder(walked);
    }
  }
}

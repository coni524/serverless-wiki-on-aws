/**
 * The Wiki as the plugin sees it, with the invariants the real one enforces.
 *
 * The one that matters here is that only a folder may hold children, because it
 * is what the plugin has to keep on its side of the line: a cycle that got the
 * mapping wrong shows up as a refusal from `requireCanHoldChildren` rather than
 * as a tree that quietly went crooked. `moveLegacy` is the door around it, for
 * the trees that exist in environments the migration has not reached.
 */
type Node = {
  id: string;
  kind: 'page' | 'folder';
  title: string;
  parent: string | null;
  revision: number;
  updatedAt: string;
  body: string;
};

export class FakeWiki {
  private readonly nodes = new Map<string, Node>();
  private next = 1;
  private clock = 0;
  readonly calls: string[] = [];

  private stamp(): string {
    this.clock += 1;
    return `2026-08-01T00:00:${String(this.clock).padStart(2, '0')}.000Z`;
  }

  private id(prefix: string): string {
    this.next += 1;
    return `${prefix}${this.next}`;
  }

  private childrenOf(id: string): Node[] {
    return [...this.nodes.values()].filter((node) => node.parent === id);
  }

  private requireCanHoldChildren(parent: string | null): void {
    if (parent === null) return;
    const node = this.nodes.get(parent);
    if (node === undefined) throw new Error(`Page not found: ${parent}`);
    if (node.kind !== 'folder') throw new Error('A page cannot hold children. Name a folder as the parent');
  }

  seedFolder(title: string, parent: string | null): string {
    this.requireCanHoldChildren(parent);
    const id = this.id('f');
    this.nodes.set(id, { id, kind: 'folder', title, parent, revision: 1, updatedAt: this.stamp(), body: '' });
    return id;
  }

  seedPage(title: string, parent: string | null, body: string): string {
    this.requireCanHoldChildren(parent);
    const id = this.id('p');
    this.nodes.set(id, { id, kind: 'page', title, parent, revision: 1, updatedAt: this.stamp(), body });
    return id;
  }

  /** What the Wiki holds: one indented line per node, folders marked `/`. */
  tree(): string[] {
    const out: string[] = [];
    const walk = (parent: string | null, depth: number): void => {
      for (const node of this.childrenOf(parent as string).sort((a, b) => a.id.localeCompare(b.id))) {
        out.push(`${'  '.repeat(depth)}${node.kind === 'folder' ? '/' : '-'} ${node.title}${node.kind === 'page' ? ` ${JSON.stringify(node.body)}` : ''}`);
        walk(node.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** The `SyncApi` surface the engine calls, recording every call it makes. */
  api() {
    const wiki = this;
    return {
      async listSpaces() {
        return [{ spaceId: 's1', name: 'memo', description: '', permission: 'write' as const }];
      },
      async listAllNodes() {
        return [...wiki.nodes.values()].map((node) => ({
          pageId: node.id,
          kind: node.kind,
          parentPageId: node.parent,
          title: node.title,
          revision: node.revision,
          updatedAt: node.updatedAt,
        }));
      },
      async getPage(pageId: string, knownStamp?: string) {
        wiki.calls.push(`getPage ${pageId}`);
        const node = wiki.nodes.get(pageId);
        if (node === undefined || node.kind !== 'page') throw new Error('Page not found');
        const stamp = `${node.revision}@${node.updatedAt}`;
        const unchanged = knownStamp === stamp;
        return {
          pageId, spaceId: 's1', kind: 'page' as const, parentPageId: node.parent,
          title: node.title, revision: node.revision, updatedAt: node.updatedAt,
          unchanged, ...(unchanged ? {} : { body: node.body }),
        };
      },
      async createPage(input: { title: string; body: string; parentPageId: string | null }) {
        wiki.calls.push(`createPage ${input.title} under ${input.parentPageId}`);
        const id = wiki.seedPage(input.title, input.parentPageId, input.body);
        return { pageId: id, spaceId: 's1', revision: 1 };
      },
      async updatePage(pageId: string, patch: { title?: string; body?: string }) {
        wiki.calls.push(`updatePage ${pageId} ${JSON.stringify(patch)}`);
        const node = wiki.nodes.get(pageId);
        if (node === undefined) throw new Error('Page not found');
        if (patch.title !== undefined) node.title = patch.title;
        if (patch.body !== undefined) node.body = patch.body;
        node.revision += 1;
        node.updatedAt = wiki.stamp();
        return { pageId, revision: node.revision };
      },
      async movePage(pageId: string, parentPageId: string | null) {
        wiki.calls.push(`movePage ${pageId} -> ${parentPageId}`);
        const node = wiki.nodes.get(pageId);
        if (node === undefined) throw new Error('Page not found');
        wiki.requireCanHoldChildren(parentPageId);
        node.parent = parentPageId;
      },
      async deletePage(pageId: string) {
        wiki.calls.push(`deletePage ${pageId}`);
        if (wiki.childrenOf(pageId).length > 0) throw new Error('That page still has children');
        wiki.nodes.delete(pageId);
      },
      async createFolder(input: { title: string; parentPageId: string | null }) {
        wiki.calls.push(`createFolder ${input.title} under ${input.parentPageId}`);
        return { folderId: wiki.seedFolder(input.title, input.parentPageId), spaceId: 's1' };
      },
      async renameFolder(folderId: string, title: string) {
        wiki.calls.push(`renameFolder ${folderId} -> ${title}`);
        const node = wiki.nodes.get(folderId);
        if (node === undefined || node.kind !== 'folder') throw new Error('Folder not found');
        node.title = title;
      },
      async deleteFolder(folderId: string) {
        wiki.calls.push(`deleteFolder ${folderId}`);
        if (wiki.childrenOf(folderId).length > 0) throw new Error('That folder still has children');
        wiki.nodes.delete(folderId);
      },
      async listAttachments() { return []; },
      async createAttachmentDownloadUrls() { return {}; },
    };
  }

  /** Put a node under a page, which only a tree from before the migration has. */
  moveLegacy(id: string, parent: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(id);
    node.parent = parent;
  }

  /** Move a node the way the Wiki's own UI would, for the pull-side cases. */
  move(id: string, parent: string | null): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(id);
    this.requireCanHoldChildren(parent);
    node.parent = parent;
  }

  rename(id: string, title: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(id);
    node.title = title;
    if (node.kind === 'page') { node.revision += 1; node.updatedAt = this.stamp(); }
  }

  write(id: string, body: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(id);
    node.body = body;
    node.revision += 1;
    node.updatedAt = this.stamp();
  }

  /** Delete a node and hand its children to its parent, as `reparent` does. */
  deleteReparent(id: string): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(id);
    for (const child of this.childrenOf(id)) child.parent = node.parent;
    this.nodes.delete(id);
  }
}

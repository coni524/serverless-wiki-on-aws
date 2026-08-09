/**
 * One sync cycle, driven against a Wiki and a vault held in memory.
 *
 * What these cover is the shape of the two trees and the direction changes
 * travel in — the part of the plugin that decides, not the part that talks. The
 * network is `wiki.ts`, the disk is `vault.ts`, and everything between them is
 * the real `SyncEngine`, `pushSpace`, `planNodes` and `SyncStateStore`.
 *
 * They exist because the cycle can delete things. A mapping that places a node
 * in the wrong place does not merely look wrong: in a space that reflects
 * deletions it reads as "the user removed this" and sends a delete. So the
 * cases below are chosen for the moves that are expensive to get wrong — a
 * folder renamed on either side, a folder deleted with contents, and the first
 * cycle after the migration, which must not move a single file.
 *
 * Run with `pnpm run test`, which bundles this with `obsidian` aliased to
 * `obsidian-stub.ts` — the package itself ships no runtime.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { App } from 'obsidian';

import type { SyncApi } from '../src/api';
import { toVaultBody } from '../src/attachments';
import { SyncStateStore } from '../src/state';
import { SyncEngine } from '../src/sync';
import { FakeVault } from './vault';
import { FakeWiki } from './wiki';

/** The state file, in memory, so a test can seed one an older version wrote. */
class FakeAdapter {
  private text: string | null = null;

  constructor(seed?: unknown) {
    if (seed !== undefined) this.text = JSON.stringify(seed);
  }

  async exists(): Promise<boolean> {
    return this.text !== null;
  }

  async read(): Promise<string> {
    return this.text ?? '';
  }

  async write(_path: string, text: string): Promise<void> {
    this.text = text;
  }

  get saved(): unknown {
    return this.text === null ? null : JSON.parse(this.text);
  }
}

function bench(options: { state?: unknown; reflectDeletes?: boolean } = {}) {
  const wiki = new FakeWiki();
  const vault = new FakeVault();
  const adapter = new FakeAdapter(options.state);
  const state = new SyncStateStore(adapter as never, 'plugins/slwiki-sync');
  const app = { vault } as unknown as App;
  const engine = new SyncEngine(app, wiki.api() as unknown as SyncApi, state, () => ({
    spaceIds: ['s1'],
    deleteSpaceIds: options.reflectDeletes === true ? ['s1'] : [],
  }));
  return { wiki, vault, state, engine, adapter };
}

test('the first cycle mirrors the tree, and the second does nothing', async () => {
  const { wiki, vault, engine } = bench();
  const design = wiki.seedFolder('設計', null);
  wiki.seedPage('概要', design, '本文A');
  wiki.seedFolder('空', design);
  wiki.seedPage('メモ', null, '本文B');

  const first = await engine.run();
  assert.deepEqual(vault.listing(), [
    'memo/',
    'memo/メモ.md',
    'memo/設計/',
    'memo/設計/概要.md',
    'memo/設計/空/',
  ]);
  assert.equal(vault.bodyOf('memo/設計/概要.md'), '本文A');
  assert.deepEqual(first.failures, []);
  // A folder holding no notes is still a folder: it is in the vault above, and
  // nothing was sent back to the Wiki to put it there.
  assert.deepEqual([first.created, first.updated, first.deleted], [0, 0, 0]);

  const second = await engine.run();
  assert.deepEqual(
    [second.fetched, second.moved, second.removed, second.created, second.unchanged],
    [0, 0, 0, 0, 2],
  );
});

test('a folder and a note made in the vault reach the Wiki', async () => {
  const { wiki, vault, engine } = bench();
  wiki.seedFolder('既存', null);
  await engine.run();

  await vault.userCreateFolder('memo/新しい/さらに下');
  await vault.create('memo/新しい/さらに下/覚書.md', 'ローカル本文');
  await vault.userCreateFolder('memo/空のまま');

  const report = await engine.run();
  assert.deepEqual(wiki.tree(), [
    '/ 既存',
    '/ 新しい',
    '  / さらに下',
    '    - 覚書 "ローカル本文"',
    '/ 空のまま',
  ]);
  assert.equal(report.created, 4);
  assert.deepEqual(report.failures, []);
  // Nothing came back the other way: the vault is exactly as the user left it.
  assert.deepEqual(vault.listing(), [
    'memo/',
    'memo/新しい/',
    'memo/新しい/さらに下/',
    'memo/新しい/さらに下/覚書.md',
    'memo/既存/',
    'memo/空のまま/',
  ]);
});

test('a folder renamed and a note moved in the vault are sent as such', async () => {
  const { wiki, vault, state, engine } = bench();
  const a = wiki.seedFolder('A', null);
  wiki.seedFolder('B', null);
  wiki.seedPage('中身', a, '本文');
  await engine.run();

  // What Obsidian reports while the plugin is loaded, which is one event for
  // the top of what moved and none for anything below it.
  await vault.rename(vault.getAbstractFileByPath('memo/A')!, 'memo/A2');
  state.trackRename('memo/A', 'memo/A2');
  await vault.rename(vault.getAbstractFileByPath('memo/A2/中身.md')!, 'memo/B/中身.md');
  state.trackRename('memo/A2/中身.md', 'memo/B/中身.md');

  const report = await engine.run();
  assert.deepEqual(wiki.tree(), ['/ A2', '/ B', '  - 中身 "本文"']);
  assert.deepEqual([report.updated, report.relocated], [1, 1]);
  assert.deepEqual(vault.listing(), ['memo/', 'memo/A2/', 'memo/B/', 'memo/B/中身.md']);
  assert.deepEqual(report.failures, []);
});

test('a folder renamed in the Wiki carries the notes under it', async () => {
  const { wiki, vault, engine } = bench();
  const a = wiki.seedFolder('A', null);
  const b = wiki.seedFolder('B', a);
  const page = wiki.seedPage('中身', b, '本文');
  await engine.run();

  wiki.rename(a, 'A の新名');
  wiki.move(page, a);

  const report = await engine.run();
  assert.deepEqual(vault.listing(), [
    'memo/',
    'memo/A の新名/',
    'memo/A の新名/B/',
    'memo/A の新名/中身.md',
  ]);
  // The body was never re-fetched: the note arrived at its new place by being
  // inside a folder that moved.
  assert.equal(vault.bodyOf('memo/A の新名/中身.md'), '本文');
  assert.deepEqual([report.created, report.updated, report.relocated, report.deleted], [0, 0, 0, 0]);
  assert.deepEqual(report.failures, []);
});

test('a folder deleted in the Wiki goes once its contents have left it', async () => {
  const { wiki, vault, engine } = bench();
  const a = wiki.seedFolder('A', null);
  wiki.seedPage('中身', a, '本文');
  await engine.run();

  wiki.deleteReparent(a);

  const report = await engine.run();
  assert.deepEqual(vault.listing(), ['memo/', 'memo/中身.md']);
  assert.deepEqual(vault.trashed, ['memo/A']);
  assert.deepEqual(report.failures, []);
});

test('a folder deleted in the vault is sent deepest first', async () => {
  const { wiki, vault, engine } = bench({ reflectDeletes: true });
  const a = wiki.seedFolder('A', null);
  const b = wiki.seedFolder('B', a);
  wiki.seedPage('中身', b, '本文');
  wiki.seedPage('残る', null, '本文');
  await engine.run();

  await vault.trash(vault.getAbstractFileByPath('memo/A')!, false);

  const report = await engine.run();
  // Every one of the three refusals `reject` could have produced was avoided by
  // the order alone; the page outside the folder is untouched.
  assert.deepEqual(wiki.tree(), ['- 残る "本文"']);
  assert.equal(report.deleted, 3);
  assert.deepEqual(report.failures, []);
});

test('a folder renamed with Obsidian closed is followed by its contents', async () => {
  const { wiki, vault, engine } = bench();
  const a = wiki.seedFolder('A', null);
  const b = wiki.seedFolder('B', a);
  wiki.seedPage('中身', b, '本文');
  await engine.run();

  // No `trackRename`: the event never arrived, so the record still names the
  // old place and the new one belongs to nobody.
  await vault.rename(vault.getAbstractFileByPath('memo/A')!, 'memo/Z');

  const report = await engine.run();
  assert.deepEqual(wiki.tree(), ['/ Z', '  / B', '    - 中身 "本文"']);
  assert.equal(report.created, 0);
  assert.deepEqual(vault.listing(), ['memo/', 'memo/Z/', 'memo/Z/B/', 'memo/Z/B/中身.md']);
  assert.deepEqual(report.failures, []);
});

test('the first cycle after the migration moves nothing', async () => {
  // A state file the previous mapping wrote: the parent page owned the folder
  // of the same name and its note sat inside it as a folder note.
  const state = {
    version: 1,
    spaces: {
      s1: {
        folder: 'memo',
        pages: {
          p3: {
            path: 'memo/親/親.md',
            folder: 'memo/親',
            syncedPath: 'memo/親/親.md',
            stamp: '1@2026-08-01T00:00:01.000Z',
            hash: 'not the current hash',
          },
          p4: {
            path: 'memo/親/子.md',
            folder: null,
            syncedPath: 'memo/親/子.md',
            stamp: '1@2026-08-01T00:00:02.000Z',
            hash: 'not the current hash',
          },
        },
      },
    },
  };
  const bed = bench({ state });
  // The Wiki after the migration: a folder holding the parent page and the
  // child page, with the ids the two pages already had.
  const folder = bed.wiki.seedFolder('親', null);
  bed.wiki.seedPage('親', folder, '親の本文');
  bed.wiki.seedPage('子', folder, '子の本文');
  // The vault as the previous version left it.
  await bed.vault.userCreateFolder('memo/親');
  await bed.vault.create('memo/親/親.md', '親の本文');
  await bed.vault.create('memo/親/子.md', '子の本文');

  const report = await bed.engine.run();
  assert.deepEqual(bed.vault.listing(), ['memo/', 'memo/親/', 'memo/親/子.md', 'memo/親/親.md']);
  assert.deepEqual(bed.vault.trashed, []);
  assert.equal(report.conflicts, 0);
  assert.deepEqual([report.created, report.updated, report.relocated, report.deleted], [0, 0, 0, 0]);
  assert.deepEqual(report.failures, []);

  const saved = bed.adapter.saved as {
    version: number;
    spaces: Record<string, { folders: Record<string, unknown> }>;
  };
  assert.equal(saved.version, 2);
  assert.equal(Object.keys(saved.spaces.s1.folders).length, 1);
});

test('a page that still has children keeps them beside its own note', async () => {
  const { wiki, vault, engine } = bench();
  const parent = wiki.seedPage('親', null, '親の本文');
  const child = wiki.seedPage('子', null, '子の本文');
  // Only a tree from before the migration looks like this, so it is built
  // around the invariant rather than through it.
  wiki.moveLegacy(child, parent);

  const report = await engine.run();
  assert.deepEqual(vault.listing(), ['memo/', 'memo/親.md', 'memo/親/', 'memo/親/子.md']);
  // The folder standing for the page is not a folder the plugin made, and it
  // does not become one: nothing was sent.
  assert.deepEqual(wiki.tree(), ['- 親 "親の本文"', '  - 子 "子の本文"']);
  assert.deepEqual(report.failures, []);
});

// ─── Bodies the Wiki hands over ──────────────────────────────────────────────
// Not a cycle: the two below are `toVaultBody` on its own, because what they
// pin down is what the plugin is willing to believe about text a stranger wrote.

/** Enough of an `AttachmentContext` for a body whose links are never resolved. */
const nowhere = {
  app: {
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
  },
  // The Wiki has no attachment to hand over, so every link is left as it is and
  // what the body says stays the only thing under test.
  api: { listAttachments: async () => [] },
  spaceFolder: 'memo',
  pageId: 'p1',
} as never;

test('a picture link the Wiki could not have meant stops being one', async () => {
  // The Wiki shows a picture only for an attachment of the page it is on, so a
  // body arriving from it that embeds a vault path is naming a file on *this*
  // disk — which nobody on the Wiki side could have meant. Left as an embed it
  // is an order to the push half: resolve that name against the vault, upload
  // whatever it finds as an attachment of the page, and the person who wrote the
  // body downloads it. That reaches files of other spaces and of notes that
  // never sync at all.
  const body = [
    '![図](attachment:att1)',
    '![](secret-architecture.png)',
    '![](../../他のスペース/_attachments/x/scan.png)',
    '![[private-diagram.png]]',
  ].join('\n\n');

  const fromWiki = await toVaultBody(nowhere, body, 'memo/note.md', {}, 'memo/note.md', 'wiki');
  assert.equal(
    fromWiki.body,
    [
      '![図](attachment:att1)',
      '[](secret-architecture.png)',
      '[](../../他のスペース/_attachments/x/scan.png)',
      '[[private-diagram.png]]',
    ].join('\n\n'),
    'Only the attachment of this page stays an embed; the rest keep their target as plain links',
  );

  // The vault's own body is untouched: those links are the user's, and turning
  // them into attachments is exactly what the push half is for.
  const fromVault = await toVaultBody(nowhere, body, 'memo/note.md', {}, 'memo/note.md', 'vault');
  assert.equal(fromVault.body, body);
});

test('a body of unclosed image markup does not stall the sync', async () => {
  // `readLinks` is the first thing either conversion does. The image pattern used
  // to let a run of spaces be split every possible way, so `![](` and a megabyte
  // of them never returned — and Obsidian stopped with it, on every cycle, until
  // the page was repaired from somewhere else.
  const bodies = [`![](${' '.repeat(300_000)}`, '!['.repeat(100_000), '![]('.repeat(50_000)];

  for (const body of bodies) {
    const started = Date.now();
    await toVaultBody(nowhere, body, 'memo/note.md', {}, 'memo/note.md', 'wiki');
    const took = Date.now() - started;
    assert.ok(took < 2000, `${JSON.stringify(body.slice(0, 4))}… took ${took}ms`);
  }
});

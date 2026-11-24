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

import { SyncApi } from '../src/api';
import { AuthClient } from '../src/auth';
import { toVaultBody, wikiTargets } from '../src/attachments';
import { DEFAULT_SETTINGS, type SlWikiSettings, type StoredTokens } from '../src/settings';
import { SyncStateStore, contentHash } from '../src/state';
import { emptyReport, worthReporting } from '../src/report';
import { SyncEngine } from '../src/sync';
import { SECRET_ID, TokenStore } from '../src/token-store';
import { type StubRequest, http } from './obsidian-stub';
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
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: (name: string) => vault.firstByName(name) },
  } as unknown as App;
  const adoptFolders: Record<string, string> = {};
  const adopted: string[] = [];
  const engine = new SyncEngine(
    app,
    wiki.api() as unknown as SyncApi,
    state,
    () => ({
      spaceIds: ['s1'],
      deleteSpaceIds: options.reflectDeletes === true ? ['s1'] : [],
      adoptFolders,
    }),
    async (spaceId) => {
      adopted.push(spaceId);
      delete adoptFolders[spaceId];
    },
  );
  return { wiki, vault, state, engine, adapter, adoptFolders, adopted };
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

test('a run of "!" in front of a picture link does not bring the embed back', async () => {
  // `!![](x)` is read as an image starting at the second `!`. Removing only
  // that one left `![](x)` — a live embed of a vault file, which the next push
  // uploaded to the page as soon as the user edited the note.
  const body = [
    '!![](scan.png)',
    '!![[scan.png]]',
    '!!!!![](../他/_attachments/x/scan.png)',
    '!![図](attachment:att1)',
    '!![![[inner.png]]](outer.png)',
    '![[a.png]]![[b.png]]!![](c.png)',
  ].join('\n\n');

  const fromWiki = await toVaultBody(nowhere, body, 'memo/note.md', {}, 'memo/note.md', 'wiki');
  assert.equal(
    fromWiki.body.split('\n\n').slice(0, 4).join('\n\n'),
    [
      '[](scan.png)',
      '[[scan.png]]',
      '[](../他/_attachments/x/scan.png)',
      // The page's own attachment is left alone, `!` and all.
      '!![図](attachment:att1)',
    ].join('\n\n'),
  );
  // Whatever else came out, nothing in it is an embed of anything but the
  // page's own attachments.
  assert.deepEqual([...wikiTargets(fromWiki.body)], []);
});

test('a picture link the Wiki slipped past an earlier version is disarmed before a push', async () => {
  const { wiki, vault, state, engine } = bench();
  http.requests.length = 0;
  http.handler = () => ({ status: 200 });
  try {
    // A file the attacker cannot read, somewhere else in the vault.
    await vault.userCreateFolder('private');
    await vault.create('private/scan.png', 'secret bytes');
    const page = wiki.seedPage('ページ', null, '!![[scan.png]]');
    await engine.run();
    assert.equal(vault.bodyOf('memo/ページ.md'), '[[scan.png]]');

    // What the earlier version wrote for the same body, and its record: a live
    // embed, the note untouched since, and no mark of having been checked.
    const note = vault.getAbstractFileByPath('memo/ページ.md') as never;
    await vault.modify(note, '![[scan.png]]');
    const known = state.get('s1')!;
    known.pages[page].hash = await contentHash('![[scan.png]]');
    delete known.linksChecked;

    const checked = await engine.run();
    assert.deepEqual(checked.failures, []);
    assert.equal(vault.bodyOf('memo/ページ.md'), '[[scan.png]]');

    // Now the user edits it, which is when the old embed would have uploaded.
    await vault.modify(note, '[[scan.png]]\n\n追記');
    const edited = await engine.run();
    assert.deepEqual(edited.failures, []);
    assert.equal(edited.uploaded, 0);
    assert.ok(!wiki.calls.some((call) => call.startsWith('upload')), wiki.calls.join('\n'));
  } finally {
    http.handler = null;
  }
});

test('an edited note keeps its own pictures and loses only the links the Wiki planted', async () => {
  const { wiki, vault, state, engine } = bench();
  http.requests.length = 0;
  http.handler = () => ({ status: 200 });
  try {
    await vault.userCreateFolder('private');
    await vault.create('private/scan.png', 'secret bytes');
    const page = wiki.seedPage('ページ', null, '!![[scan.png]]');
    await engine.run();

    // The earlier version's note, edited by the user before this version ran:
    // the planted embed, and a picture the user pasted themselves.
    await vault.create('memo/mine.png', 'my bytes');
    const note = vault.getAbstractFileByPath('memo/ページ.md') as never;
    await vault.modify(note, '![[scan.png]]\n\n追記 ![[mine.png]]');
    const known = state.get('s1')!;
    known.pages[page].hash = await contentHash('![[scan.png]]');
    delete known.linksChecked;

    const report = await engine.run();
    assert.deepEqual(report.failures, []);
    const uploads = wiki.calls.filter((call) => call.startsWith('upload'));
    assert.deepEqual(uploads, [`upload mine.png to ${page}`]);
    assert.deepEqual(wiki.tree(), ['- ページ "[[scan.png]]\\n\\n追記 ![mine.png](attachment:att1)"']);
  } finally {
    http.handler = null;
  }
});

// ─── The space's own folder ──────────────────────────────────────────────────

test('a renamed space takes its folder along before anything is sent', async () => {
  const { wiki, vault, engine } = bench();
  wiki.seedPage('メモ', null, '本文');
  await engine.run();

  wiki.spaceName = '新しい名前';
  const report = await engine.run();
  assert.deepEqual(vault.listing(), ['新しい名前/', '新しい名前/メモ.md']);
  assert.deepEqual([report.created, report.updated, report.deleted], [0, 0, 0]);
  assert.deepEqual(report.failures, []);
});

test('a space renamed after a folder that already exists sends nothing from it', async () => {
  const { wiki, vault, engine } = bench({ reflectDeletes: true });
  wiki.seedPage('メモ', null, '本文');
  await engine.run();
  await vault.userCreateFolder('Journal');
  await vault.create('Journal/日記.md', '誰にも見せない');
  const before = wiki.calls.length;

  wiki.spaceName = 'Journal';
  const report = await engine.run();
  assert.deepEqual(wiki.calls.slice(before), []);
  assert.deepEqual(wiki.tree(), ['- メモ "本文"']);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /already exists/);
  assert.deepEqual(vault.listing(), ['Journal/', 'Journal/日記.md', 'memo/', 'memo/メモ.md']);
});

test('a renamed space whose recorded folder is gone sends nothing', async () => {
  const { wiki, vault, engine } = bench();
  wiki.seedPage('メモ', null, '本文');
  await engine.run();
  await vault.trash(vault.getAbstractFileByPath('memo')!, false);
  await vault.userCreateFolder('Journal');
  await vault.create('Journal/日記.md', '誰にも見せない');
  const before = wiki.calls.length;

  wiki.spaceName = 'Journal';
  const report = await engine.run();
  assert.deepEqual(wiki.calls.slice(before), []);
  assert.match(report.failures[0] ?? '', /missing/);
});

test('a first cycle into a folder that already holds notes waits to be confirmed', async () => {
  const { wiki, vault, engine, adapter, adoptFolders, adopted } = bench();
  await vault.userCreateFolder('memo');
  await vault.create('memo/手元.md', '手元の本文');

  const paused = await engine.run();
  assert.deepEqual(paused.paused, [{ spaceId: 's1', name: 'memo', folder: 'memo' }]);
  assert.deepEqual(wiki.calls, []);
  assert.deepEqual(engine.awaiting.get('s1'), 'memo');
  // No record either, or the next cycle would take the folder as the space's.
  assert.deepEqual((adapter.saved as { spaces: object }).spaces, {});
  assert.deepEqual((await engine.run()).paused.length, 1);
  assert.deepEqual(wiki.calls, []);

  // A confirmation for some other folder is not one for this folder.
  adoptFolders.s1 = 'old name';
  assert.equal((await engine.run()).paused.length, 1);
  assert.deepEqual(wiki.calls, []);

  adoptFolders.s1 = 'memo';
  const imported = await engine.run();
  assert.deepEqual(imported.paused, []);
  assert.deepEqual(imported.failures, []);
  assert.deepEqual(wiki.tree(), ['- 手元 "手元の本文"']);
  assert.deepEqual(adopted, ['s1']);
  assert.equal(engine.awaiting.size, 0);
});

test('a paused space is announced once, not on every timed cycle', () => {
  const report = emptyReport();
  report.paused.push({ spaceId: 's1', name: 'memo', folder: 'memo' });
  assert.equal(worthReporting(report), false);
});

test('a folder whose name differs from the space only in case is never taken for it', async () => {
  // First cycle: `Memo` may be the very folder `memo` names on this disk.
  const first = bench();
  await first.vault.userCreateFolder('Memo');
  await first.vault.create('Memo/日記.md', '誰にも見せない');
  first.wiki.seedPage('メモ', null, '本文');
  const report = await first.engine.run();
  assert.deepEqual(first.wiki.calls, []);
  assert.deepEqual(report.paused, []);
  assert.match(report.failures[0] ?? '', /only in case/);
  assert.deepEqual(first.vault.listing(), ['Memo/', 'Memo/日記.md']);
  assert.deepEqual((first.adapter.saved as { spaces: object }).spaces, {});

  // A rename onto a name another folder has in a different case.
  const renamed = bench();
  renamed.wiki.seedPage('メモ', null, '本文');
  await renamed.engine.run();
  await renamed.vault.userCreateFolder('journal');
  await renamed.vault.create('journal/日記.md', '誰にも見せない');
  const before = renamed.wiki.calls.length;
  renamed.wiki.spaceName = 'Journal';
  const skipped = await renamed.engine.run();
  assert.deepEqual(renamed.wiki.calls.slice(before), []);
  assert.match(skipped.failures[0] ?? '', /already exists/);

  // A rename of the space that changes only its own case is still followed.
  const own = bench();
  own.wiki.seedPage('メモ', null, '本文');
  await own.engine.run();
  own.wiki.spaceName = 'Memo';
  const followed = await own.engine.run();
  assert.deepEqual(followed.failures, []);
  assert.deepEqual(own.vault.listing(), ['Memo/', 'Memo/メモ.md']);
});

test('the record names the moved folder before the cycle goes on', async () => {
  const { wiki, engine, adapter } = bench();
  wiki.seedPage('メモ', null, '本文');
  await engine.run();

  let seen: unknown = null;
  wiki.beforeList = () => {
    seen = adapter.saved;
  };
  wiki.spaceName = '新しい名前';
  await engine.run();
  assert.equal((seen as { spaces: Record<string, { folder: string }> }).spaces.s1.folder, '新しい名前');
});

test('a conflict copy written by an earlier version loses the links the Wiki planted', async () => {
  const { wiki, vault, state, engine } = bench();
  await vault.userCreateFolder('private');
  await vault.create('private/scan.png', 'secret bytes');
  wiki.seedPage('ページ', null, '!![[scan.png]]');
  await engine.run();

  const copy = 'memo/ページ (conflict 2026-08-01 0000).md';
  await vault.create(copy, '![[scan.png]] と手元の文 ![[mine.png]]');
  delete state.get('s1')!.linksChecked;
  const report = await engine.run();
  assert.deepEqual(report.failures, []);
  assert.equal(vault.bodyOf(copy), '[[scan.png]] と手元の文 ![[mine.png]]');
});

test('a first cycle into an empty folder needs no confirmation', async () => {
  const { wiki, vault, engine } = bench();
  await vault.userCreateFolder('memo');
  wiki.seedPage('メモ', null, '本文');
  const report = await engine.run();
  assert.deepEqual(report.paused, []);
  assert.deepEqual(vault.listing(), ['memo/', 'memo/メモ.md']);
});

// ─── Tokens ──────────────────────────────────────────────────────────────────

const WIKI_A = 'https://a.example';

/** Wiki A answers properly; anything else is somebody asking for A's tokens. */
function wikiA(
  options: { ext?: (request: StubRequest) => number; discovery?: Record<string, string> | null } = {},
) {
  let issued = 0;
  return (request: StubRequest) => {
    if (request.url === `${WIKI_A}/.well-known/oauth-authorization-server`) {
      if (options.discovery === null) return { status: 500 };
      return {
        status: 200,
        text: JSON.stringify(
          options.discovery ?? {
            authorization_endpoint: 'https://auth-a.example/authorize',
            token_endpoint: 'https://auth-a.example/token',
            revocation_endpoint: 'https://auth-a.example/revoke',
          },
        ),
      };
    }
    if (request.url === 'https://auth-a.example/token') {
      issued += 1;
      return {
        status: 200,
        text: JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600, refresh_token: 'refresh-A' }),
      };
    }
    if (request.url === 'https://auth-a.example/revoke') return { status: 200 };
    if (request.url.startsWith(`${WIKI_A}/ext/`)) {
      const status = options.ext?.(request) ?? 200;
      return { status, text: status === 200 ? '{"spaces":[]}' : '{}' };
    }
    return {
      status: 401,
      text: JSON.stringify({ token_endpoint: 'https://evil.example/token' }),
    };
  };
}

function authBench(
  settings: Partial<SlWikiSettings> = {},
  confirm: (from: string, to: string) => Promise<boolean> = async () => false,
) {
  const host = {
    settings: { ...DEFAULT_SETTINGS, wikiUrl: `${WIKI_A}/`, clientId: 'client-a', ...settings },
    saveSettings: async () => undefined,
  };
  const auth = new AuthClient(host, () => undefined);
  const api = new SyncApi(host, auth);
  const opened: string[] = [];
  (globalThis as { window?: unknown }).window = { open: (url: string) => opened.push(url) };
  const signIn = async (between?: () => void) => {
    await auth.beginSignIn(confirm);
    const state = new URL(opened[opened.length - 1]).searchParams.get('state') ?? '';
    between?.();
    await auth.handleCallback({ code: 'code', state });
  };
  return { host, auth, api, signIn, opened };
}

/** Every request that went anywhere but Wiki A and its own Cognito. */
const strays = (): string[] =>
  http.requests
    .map((request) => request.url)
    .filter((url) => !url.startsWith(WIKI_A) && !url.startsWith('https://auth-a.example/'));

test('tokens from one Wiki are never sent to a Wiki URL typed in afterwards', async () => {
  http.handler = wikiA();
  try {
    const { host, auth, api, signIn } = authBench();
    await signIn();
    assert.equal(host.settings.tokens?.issuer?.wikiUrl, WIKI_A);
    assert.equal(auth.signedIn, true);

    http.requests.length = 0;
    host.settings.wikiUrl = 'https://b.example';
    await assert.rejects(api.listSpaces());
    assert.deepEqual(http.requests, [], 'nothing at all is sent');
    assert.equal(auth.signedIn, false);
    assert.equal(auth.otherIssuer, WIKI_A);

    // Not cleared on the way: putting the address back restores the sign-in.
    host.settings.wikiUrl = WIKI_A;
    assert.deepEqual(await api.listSpaces(), []);
    assert.deepEqual(strays(), []);
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('a 401 retry is not sent anywhere when the address changed while the request was out', async () => {
  const bed = authBench();
  http.handler = wikiA({
    ext: () => {
      bed.host.settings.wikiUrl = 'https://b.example';
      return 401;
    },
  });
  try {
    await bed.signIn();
    http.requests.length = 0;
    await assert.rejects(bed.api.listSpaces());
    // The one request to A, and then nothing: no refresh, no retry, no B.
    assert.deepEqual(
      http.requests.map((request) => request.url),
      [`${WIKI_A}/ext/listSpaces`],
    );
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('a 401 retry refreshes at the recorded endpoint and goes back to the same Wiki', async () => {
  let calls = 0;
  http.handler = wikiA({ ext: () => (++calls === 1 ? 401 : 200) });
  try {
    const { api, signIn } = authBench();
    await signIn();
    http.requests.length = 0;
    assert.deepEqual(await api.listSpaces(), []);
    assert.deepEqual(
      http.requests.map((request) => request.url),
      [`${WIKI_A}/ext/listSpaces`, 'https://auth-a.example/token', `${WIKI_A}/ext/listSpaces`],
    );
    assert.equal(http.requests[2].headers?.Authorization, 'Bearer access-2');
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('signing out revokes only at the Wiki the tokens came from', async () => {
  http.handler = wikiA();
  try {
    const elsewhere = authBench();
    await elsewhere.signIn();
    http.requests.length = 0;
    elsewhere.host.settings.wikiUrl = 'https://b.example';
    await elsewhere.auth.signOut();
    assert.deepEqual(http.requests, []);
    assert.equal(elsewhere.host.settings.tokens, null);

    const home = authBench();
    await home.signIn();
    http.requests.length = 0;
    await home.auth.signOut();
    assert.deepEqual(
      (http.requests as StubRequest[]).map((request) => [request.url, request.body]),
      [['https://auth-a.example/revoke', 'token=refresh-A&client_id=client-a']],
    );
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('a sign-in finishes against the Wiki it was started for', async () => {
  http.handler = wikiA();
  try {
    const { host, auth, signIn } = authBench();
    await signIn(() => {
      host.settings.wikiUrl = 'https://b.example';
    });
    assert.deepEqual(strays(), []);
    assert.equal(host.settings.tokens?.issuer?.wikiUrl, WIKI_A);
    assert.equal(auth.signedIn, false);
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

const LEGACY: StoredTokens = {
  accessToken: 'old',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() + 3_600_000,
  issuer: null,
};

test('tokens an earlier version stored are adopted for the Wiki the settings name', async () => {
  http.handler = wikiA();
  try {
    const { host, auth, api } = authBench({ tokens: { ...LEGACY } });
    http.requests.length = 0;
    // Not used as they are: nothing is sent until they have an issuer.
    assert.equal(auth.signedIn, false);
    assert.equal(auth.legacy, true);
    await assert.rejects(api.listSpaces());
    assert.deepEqual(http.requests, []);

    assert.equal(await auth.adoptLegacy(), true);
    assert.deepEqual(host.settings.tokens?.issuer, {
      wikiUrl: WIKI_A,
      clientId: 'client-a',
      tokenEndpoint: 'https://auth-a.example/token',
      revocationEndpoint: 'https://auth-a.example/revoke',
    });
    assert.deepEqual(await api.listSpaces(), []);
    assert.deepEqual(strays(), []);
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('tokens an earlier version stored are revoked on sign-out, or kept when that cannot be done', async () => {
  http.handler = wikiA();
  try {
    const { host, auth } = authBench({ tokens: { ...LEGACY } });
    http.requests.length = 0;
    await auth.signOut();
    assert.deepEqual(
      (http.requests as StubRequest[]).filter((request) => request.method === 'POST').map((request) => [request.url, request.body]),
      [['https://auth-a.example/revoke', 'token=old-refresh&client_id=client-a']],
    );
    assert.equal(host.settings.tokens, null);
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }

  // A discovery document that cannot be trusted adopts nothing, and the
  // tokens are kept, unused, for a later attempt.
  http.handler = wikiA({
    discovery: {
      authorization_endpoint: 'https://auth-a.example/authorize',
      token_endpoint: 'https://evil.example/token',
    },
  });
  try {
    const { host, auth, api } = authBench({ tokens: { ...LEGACY } });
    assert.equal(await auth.adoptLegacy(), false);
    assert.equal(host.settings.tokens?.issuer, null);
    await assert.rejects(api.listSpaces());
    assert.deepEqual(strays(), []);
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

test('a discovery document is trusted only when every endpoint is https on one origin', async () => {
  const documents = [
    { authorization_endpoint: 'https://auth-a.example/authorize', token_endpoint: 'http://auth-a.example/token' },
    { authorization_endpoint: 'https://auth-a.example/authorize', token_endpoint: 'https://evil.example/token' },
    {
      authorization_endpoint: 'https://auth-a.example/authorize',
      token_endpoint: 'https://auth-a.example/token',
      revocation_endpoint: 'https://evil.example/revoke',
    },
  ];
  for (const discovery of documents) {
    http.handler = wikiA({ discovery });
    try {
      const { auth, opened } = authBench();
      await assert.rejects(auth.beginSignIn(async () => true), /https/);
      assert.deepEqual(opened, []);
      assert.deepEqual(strays(), []);
    } finally {
      http.handler = null;
      http.requests.length = 0;
    }
  }
});

test('signing in at a new address under the same client id asks first', async () => {
  http.handler = wikiA();
  try {
    const asked: string[][] = [];
    const bed = authBench({}, async (from, to) => {
      asked.push([from, to]);
      return false;
    });
    await bed.signIn();
    bed.host.settings.wikiUrl = 'https://b.example';
    http.requests.length = 0;
    await assert.rejects(bed.auth.beginSignIn(async (from, to) => {
      asked.push([from, to]);
      return false;
    }));
    assert.deepEqual(asked, [[WIKI_A, 'https://b.example']]);
    // Declined: nothing was even fetched from the new address.
    assert.deepEqual(http.requests, []);

    await assert.rejects(bed.auth.beginSignIn(async () => true));
    assert.deepEqual(
      (http.requests as StubRequest[]).map((request) => request.url),
      ['https://b.example/.well-known/oauth-authorization-server'],
    );

    // A new client id is what a real move looks like, and is not asked about.
    bed.host.settings.clientId = 'client-b';
    await assert.rejects(
      bed.auth.beginSignIn(async () => {
        throw new Error('asked');
      }),
      (error: Error) => error.message !== 'asked',
    );
  } finally {
    http.handler = null;
    http.requests.length = 0;
  }
});

// ─── Where the tokens are kept ───────────────────────────────────────────────

const TOKENS: StoredTokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 1,
  issuer: {
    wikiUrl: WIKI_A,
    clientId: 'client-a',
    tokenEndpoint: 'https://auth-a.example/token',
    revocationEndpoint: null,
  },
};

class FakeSecrets {
  readonly values = new Map<string, string>();
  constructor(private readonly keeps = true) {}
  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  setSecret(id: string, secret: string): void {
    if (this.keeps) this.values.set(id, secret);
  }
}

test('tokens in data.json move to secret storage once the copy reads back', () => {
  const secrets = new FakeSecrets();
  const store = new TokenStore(secrets);
  const loaded = store.load({ wikiUrl: WIKI_A, clientId: 'client-a', tokens: TOKENS });
  assert.deepEqual(loaded.settings.tokens, TOKENS);
  assert.equal(loaded.rewrite, true);
  assert.deepEqual(JSON.parse(secrets.getSecret(SECRET_ID) ?? 'null'), TOKENS);
  assert.equal(store.secure, true);

  // What `saveData` receives has no tokens in it.
  const saved = store.persist(loaded.settings);
  assert.equal(saved.tokens, null);
  assert.deepEqual(loaded.settings.tokens, TOKENS, 'the copy in memory is untouched');

  // The next start reads them back from secret storage alone.
  const again = new TokenStore(secrets).load(saved);
  assert.deepEqual(again.settings.tokens, TOKENS);
  assert.equal(again.rewrite, false);

  // Signing out overwrites the secret, which has no delete.
  store.persist({ ...loaded.settings, tokens: null });
  assert.equal(secrets.getSecret(SECRET_ID), '');
  assert.equal(new TokenStore(secrets).load(saved).settings.tokens, null);
});

test('tokens stay in data.json when secret storage does not keep them', () => {
  const store = new TokenStore(new FakeSecrets(false));
  const loaded = store.load({ tokens: TOKENS });
  assert.equal(loaded.rewrite, false);
  assert.deepEqual(loaded.settings.tokens, TOKENS);
  assert.equal(store.secure, false);
  assert.deepEqual(store.persist(loaded.settings).tokens, TOKENS);
});

test('a sign-out that secret storage will not clear is an error, not a silent success', () => {
  const secrets = new FakeSecrets();
  const store = new TokenStore(secrets);
  store.persist({ ...DEFAULT_SETTINGS, tokens: TOKENS });
  // From here on the stored value no longer changes.
  secrets.setSecret = () => undefined;
  assert.throws(() => store.persist({ ...DEFAULT_SETTINGS, tokens: null }));
});

test('without secret storage the tokens stay in data.json', () => {
  const store = new TokenStore(null);
  const loaded = store.load({ tokens: TOKENS });
  assert.equal(store.secure, false);
  assert.equal(loaded.rewrite, false);
  assert.deepEqual(store.persist(loaded.settings).tokens, TOKENS);

  const legacy = new TokenStore(null).load({ tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
  assert.equal(legacy.settings.tokens?.issuer, null);
  assert.equal(legacy.rewrite, false);
});

test('tokens an earlier version stored move to secret storage too, still without an issuer', () => {
  const secrets = new FakeSecrets();
  const store = new TokenStore(secrets);
  const migrated = store.load({ tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
  assert.deepEqual(migrated.settings.tokens, { accessToken: 'a', refreshToken: 'r', expiresAt: 1, issuer: null });
  assert.equal(migrated.rewrite, true);
  assert.equal(store.persist(migrated.settings).tokens, null);
  assert.equal(JSON.parse(secrets.getSecret(SECRET_ID) ?? 'null').refreshToken, 'r');
});

test('saving the settings while signed out does not touch secret storage', () => {
  let writes = 0;
  const secrets = new FakeSecrets();
  const store = new TokenStore(secrets);
  secrets.setSecret = () => {
    writes += 1;
    throw new Error('secret storage is broken');
  };
  const loaded = store.load({ wikiUrl: WIKI_A });
  // Every keystroke in a settings field is a save; none of them fails or writes.
  for (let keystroke = 0; keystroke < 5; keystroke += 1) {
    assert.equal(store.persist(loaded.settings).tokens, null);
  }
  assert.equal(writes, 0);
});

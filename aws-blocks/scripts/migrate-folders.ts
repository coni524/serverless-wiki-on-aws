/**
 * Turn every page that holds children into a folder holding that page.
 *
 *   dry run:  AWS_PROFILE=<profile> pnpm run migrate-folders -- --table <name>
 *   apply:    AWS_PROFILE=<profile> pnpm run migrate-folders -- --table <name> --apply
 *   local:    pnpm run migrate-folders -- --local [--apply]
 *
 * Pages may no longer hold children. For each page P that has some, this cuts a
 * folder F out of P — same name, same parent, same place among its siblings —
 * moves P inside F as a leaf, and re-points P's children at F. Nothing about P
 * changes but its parent and its position: the page id, the body, the revision
 * and the attachments all stay, so shared links and body links survive.
 *
 * The vault does not move either. What the sync plugin wrote as a folder note
 * `X/X.md` is exactly where "the page X inside the folder X" lands.
 *
 * Idempotent, because F's id is derived from P's rather than drawn fresh: a
 * re-run finds the folder it wrote last time and moves on. That is what makes an
 * interrupted run safe to repeat — and an interrupted run leaves the tree
 * readable in the meantime, since a child still pointing at P is a child of a
 * page, which is what the whole table looked like before this script existed.
 *
 * The depth cap cannot be reached by this. A page with children sits at most at
 * level 9 — its child is at 10, which the cap already allowed — so the note this
 * pushes down one level lands at 10 at the deepest. The run reports the deepest
 * level it produced anyway, because that reasoning is only as good as the tree
 * actually being within the cap when the run starts.
 *
 * Only `model.ts` spells keys and positions. This script calls the same builders
 * the API does, so a mistyped index cannot creep in here alone — and a wrong
 * `gsi1pk` would not raise an error, it would quietly drop a page out of its
 * parent's listing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ALL_SPACES,
  MAX_DEPTH,
  META,
  PAGE_REF_SK,
  PAGE_SK_PREFIX,
  type Item,
  after,
  between,
  idOf,
  itemSchema,
  kindOf,
  pageRefPk,
  pageSk,
  parentKey,
  siblingSk,
  spacePk,
} from '../model.js';
import { devServerIsUp } from './seed-admin.js';

/** The mock's data file, keyed by the scope and table id in `resources.ts`. */
const LOCAL_DATA_FILE = join(process.cwd(), '.bb-data', 'sl-wiki-permissions', 'data.json');

/** The mock serialises a primary key as `JSON.stringify([pk, sk])`. */
const localKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);

/**
 * The folder cut out of a page, named after it.
 *
 * Derived rather than random so the script is idempotent. It also stays legible
 * in a URL a year from now: the folder that used to be this page.
 */
export const folderIdFor = (pageId: string) => `f-${pageId}`;

// ─── Planning ────────────────────────────────────────────────────────────────

/** One page that has to become a folder, with everything the writes need. */
export type Conversion = {
  spaceId: string;
  /** The page being cut in two. */
  page: Item;
  folderId: string;
  /**
   * Where the new folder hangs, once every conversion in this space has run.
   *
   * Not simply the page's own parent. A parent that is itself being cut in two
   * is not where anything ends up: the node that stays at that spot in the tree
   * is the folder cut out of it, and reading the stale parent instead would
   * leave this folder hanging off a page — the one shape the migration exists
   * to remove.
   */
  parentAfter: string | undefined;
  /** The page's new position, inside its own folder. */
  notePosition: string;
  /**
   * The nodes this folder has to adopt.
   *
   * Children that are themselves being converted are left out: what takes their
   * place under this folder is their own folder, which their own conversion
   * writes with this folder as its parent.
   */
  children: Item[];
};

/**
 * Work out what this space needs, reading nothing but the items it was given.
 *
 * Pure, so the shape of the plan can be checked without a table behind it.
 */
export function planSpace(spaceId: string, pages: Item[], clock: number): Conversion[] {
  const byParent = new Map<string, Item[]>();
  for (const page of pages) {
    const parent = page.parentPageId;
    if (parent === undefined) continue;
    const siblings = byParent.get(parent);
    if (siblings === undefined) byParent.set(parent, [page]);
    else siblings.push(page);
  }

  // Which pages are being cut in two has to be settled before any of them is
  // described, because each one's parent may be another one.
  const converting = new Set<string>();
  for (const page of pages) {
    if (kindOf(page) !== 'page') continue;
    const id = idOf(page.sk);
    if ((byParent.get(id) ?? []).length > 0) converting.add(id);
  }

  const conversions: Conversion[] = [];
  for (const page of pages) {
    const id = idOf(page.sk);
    if (!converting.has(id)) continue;
    const children = byParent.get(id) ?? [];

    // The note goes first among its new siblings where there is room for it.
    // The children keep the positions they have, so the only way to land in
    // front of them is a position below the lowest — and when nothing fits
    // below it, the note appends instead of displacing anything.
    const lowest = children
      .map((child) => child.position ?? '')
      .reduce((low, position) => (low === '' || position < low ? position : low), '');
    const notePosition = (lowest === '' ? null : between('', lowest)) ?? after(lowest, clock);

    const parent = page.parentPageId;
    conversions.push({
      spaceId,
      page,
      folderId: folderIdFor(id),
      parentAfter:
        parent === undefined ? undefined : converting.has(parent) ? folderIdFor(parent) : parent,
      notePosition,
      children: children.filter((child) => !converting.has(idOf(child.sk))),
    });
  }
  return conversions;
}

/** The folder record cut out of a page. */
export function folderRecord(conversion: Conversion, at: string): Item {
  const { spaceId, page, folderId, parentAfter } = conversion;
  return itemSchema.parse({
    pk: spacePk(spaceId),
    sk: pageSk(folderId),
    type: 'PAGE',
    kind: 'folder',
    gsi1pk: parentKey(spaceId, parentAfter),
    gsi1sk: siblingSk(page.position ?? '', folderId),
    title: page.title,
    ...(parentAfter === undefined ? {} : { parentPageId: parentAfter }),
    position: page.position,
    createdAt: page.createdAt ?? at,
    updatedAt: at,
    ...(page.createdBy === undefined ? {} : { createdBy: page.createdBy }),
    ...(page.updatedBy === undefined ? {} : { updatedBy: page.updatedBy }),
  });
}

/** The locator that lets the new folder's id resolve to its space. */
export const folderLocator = (conversion: Conversion, at: string): Item =>
  itemSchema.parse({
    pk: pageRefPk(conversion.folderId),
    sk: PAGE_REF_SK,
    type: 'PAGE_REF',
    spaceId: conversion.spaceId,
    createdAt: at,
  });

/** A node re-pointed at a new parent, everything else about it untouched. */
export function reparented(
  spaceId: string,
  node: Item,
  parentPageId: string,
  position: string,
): Item {
  return itemSchema.parse({
    ...node,
    kind: kindOf(node),
    parentPageId,
    position,
    gsi1pk: parentKey(spaceId, parentPageId),
    gsi1sk: siblingSk(position, idOf(node.sk)),
  });
}

/** How deep a node sits, counting the top level as 1. */
function depthOf(node: Item, byId: Map<string, Item>): number {
  let depth = 1;
  let parent = node.parentPageId;
  while (parent !== undefined && depth <= MAX_DEPTH + 1) {
    const above = byId.get(parent);
    if (above === undefined) break;
    depth += 1;
    parent = above.parentPageId;
  }
  return depth;
}

// ─── Stores ──────────────────────────────────────────────────────────────────

type Store = {
  spaceIds(): Promise<string[]>;
  pagesOf(spaceId: string): Promise<Item[]>;
  put(record: Item): Promise<void>;
};

function localStore(): Store {
  if (!existsSync(LOCAL_DATA_FILE)) {
    throw new Error(`${LOCAL_DATA_FILE} does not exist; there is nothing to migrate.`);
  }
  const entries = JSON.parse(readFileSync(LOCAL_DATA_FILE, 'utf8')) as [string, Item][];
  const data = new Map(entries);
  const flush = () => writeFileSync(LOCAL_DATA_FILE, `${JSON.stringify([...data], null, 2)}\n`);

  return {
    async spaceIds() {
      return [...data.values()]
        .filter((item) => item.type === 'SPACE' && item.sk === META)
        .map((item) => idOf(item.pk));
    },
    async pagesOf(spaceId) {
      const pk = spacePk(spaceId);
      return [...data.values()].filter(
        (item) => item.pk === pk && item.type === 'PAGE' && item.sk.startsWith(PAGE_SK_PREFIX),
      );
    },
    async put(record) {
      data.set(localKey(record.pk, record.sk), record);
      flush();
    },
  };
}

const run = promisify(execFile);

async function awsCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run('aws', [...args, '--output', 'json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

type Wire = Record<string, { S?: string; N?: string; BOOL?: boolean }>;

function marshal(record: Item): Wire {
  return Object.fromEntries(
    Object.entries(record).map(([field, value]) => {
      if (typeof value === 'string') return [field, { S: value }];
      if (typeof value === 'boolean') return [field, { BOOL: value }];
      if (typeof value === 'number') return [field, { N: String(value) }];
      throw new Error(`Cannot marshal ${field}: ${typeof value}`);
    }),
  );
}

function unmarshal(item: Wire): Item {
  const record = Object.fromEntries(
    Object.entries(item).map(([field, value]) => {
      if (value.S !== undefined) return [field, value.S];
      if (value.BOOL !== undefined) return [field, value.BOOL];
      if (value.N !== undefined) return [field, Number(value.N)];
      throw new Error(`Cannot read ${field}`);
    }),
  );
  return itemSchema.parse(record);
}

function awsStore(tableName: string): Store {
  /** Every page of a query, followed to the end rather than trusting one call. */
  const queryAll = async (args: string[]): Promise<Wire[]> => {
    const items: Wire[] = [];
    let startKey: string | undefined;
    for (;;) {
      const result = await awsCli([
        'dynamodb',
        'query',
        '--table-name',
        tableName,
        ...args,
        ...(startKey === undefined ? [] : ['--exclusive-start-key', startKey]),
      ]);
      items.push(...((result.Items ?? []) as Wire[]));
      const last = result.LastEvaluatedKey;
      if (last === undefined) return items;
      startKey = JSON.stringify(last);
    }
  };

  return {
    async spaceIds() {
      const items = await queryAll([
        '--index-name',
        'gsi1',
        '--key-condition-expression',
        'gsi1pk = :pk',
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: ALL_SPACES } }),
      ]);
      return items
        .filter((item) => item.sk?.S === META && item.pk?.S !== undefined)
        .map((item) => idOf(item.pk!.S!));
    },
    async pagesOf(spaceId) {
      const items = await queryAll([
        '--key-condition-expression',
        'pk = :pk AND begins_with(sk, :sk)',
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: spacePk(spaceId) }, ':sk': { S: PAGE_SK_PREFIX } }),
      ]);
      return items.map(unmarshal).filter((item) => item.type === 'PAGE');
    },
    async put(record) {
      await awsCli([
        'dynamodb',
        'put-item',
        '--table-name',
        tableName,
        '--item',
        JSON.stringify(marshal(record)),
      ]);
    },
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Convert every space, or report what a conversion would do.
 *
 * The writes go folder first, then the children, then the page itself. Each
 * prefix of that order leaves a readable tree: a folder nothing points at, then
 * children under the folder while the page still sits where it always did, and
 * only last the page moving inside. The reverse order would put the page inside
 * a folder while its children still hung off the page — a page with children,
 * one level deeper than it was, and one crash away from staying there.
 */
export async function migrate(
  store: Store,
  options: { apply: boolean; clock?: number },
  log: (line: string) => void = console.log,
): Promise<{ folders: number; moved: number; deepest: number }> {
  const at = new Date().toISOString();
  const clock = options.clock ?? Date.now();
  let folders = 0;
  let moved = 0;
  let deepest = 0;

  for (const spaceId of await store.spaceIds()) {
    const pages = await store.pagesOf(spaceId);
    const conversions = planSpace(spaceId, pages, clock);
    const byId = new Map(pages.map((page) => [idOf(page.sk), page]));
    for (const page of pages) {
      const depth = depthOf(page, byId);
      // A converted page's note ends up one level below where the page was.
      const depthAfter = conversions.some((c) => c.page.sk === page.sk) ? depth + 1 : depth;
      if (depthAfter > deepest) deepest = depthAfter;
    }
    if (conversions.length === 0) continue;

    log(`space ${spaceId}: ${conversions.length} page(s) hold children`);
    for (const conversion of conversions) {
      // `JSON.stringify` rather than the title as it stands: this line goes to
      // an operator's terminal, and a title is text a user wrote. One holding
      // an escape sequence could erase the lines already printed and write its
      // own plan in their place, which is the report the operator then approves
      // `--apply` from. Stringifying escapes every control character and keeps
      // the quotes this line always had. Titles stored from now on cannot carry
      // one (`requireOneLine` in `wiki-ops.ts`); the ones already in the table can.
      log(
        `  ${JSON.stringify(conversion.page.title ?? '')} → folder ${conversion.folderId}, ` +
          `holding the page itself and ${conversion.children.length} other node(s)`,
      );
      folders += 1;
      // The page itself moves too, which is the point of the whole exercise.
      moved += conversion.children.length + 1;
      if (!options.apply) continue;

      await store.put(folderLocator(conversion, at));
      await store.put(folderRecord(conversion, at));
      for (const child of conversion.children) {
        // The child keeps the position it has: it is moving to a sibling list
        // that holds the same nodes it was already ordered against.
        await store.put(reparented(spaceId, child, conversion.folderId, child.position ?? ''));
      }
      await store.put(
        reparented(spaceId, conversion.page, conversion.folderId, conversion.notePosition),
      );
    }
  }

  log(
    options.apply
      ? `Converted ${folders} page(s); ${moved} node(s) changed parent.`
      : `Would convert ${folders} page(s); ${moved} node(s) would change parent. ` +
          'Re-run with --apply to write.',
  );
  if (deepest > MAX_DEPTH) {
    throw new Error(
      `The tree would reach ${deepest} levels, past the cap of ${MAX_DEPTH}. ` +
        'Nothing was written past this point; flatten the deepest branch first.',
    );
  }
  log(`Deepest level after migration: ${deepest} (cap ${MAX_DEPTH}).`);
  return { folders, moved, deepest };
}

/** Migrate the local mock. Exported for the e2e suite, which stops the server itself. */
export const migrateLocal = (apply: boolean, log?: (line: string) => void) =>
  migrate(localStore(), { apply }, log);

function usage(): never {
  console.error(
    'Usage:\n' +
      '  pnpm run migrate-folders -- --table <table-name> [--apply]   (deployed stack)\n' +
      '  pnpm run migrate-folders -- --local [--apply]                (local mock)\n' +
      '\n' +
      'Without --apply nothing is written; the run reports what it would do.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--table');
  const tableName = at === -1 ? undefined : args[at + 1];
  const local = args.includes('--local');
  const apply = args.includes('--apply');

  if (local === (tableName !== undefined)) usage();

  if (local) {
    // The mock rewrites its data file whole on every write, so a change made
    // underneath a running server is dropped by that server's next write.
    if (await devServerIsUp()) {
      console.error('The dev server is running. Stop it, re-run this, then start it again.');
      process.exit(1);
    }
    await migrateLocal(apply);
    return;
  }

  await migrate(awsStore(tableName as string), { apply });
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

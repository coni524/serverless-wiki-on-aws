/**
 * The permission table of the local dev server, as a file the operator scripts
 * read and write while that server is stopped.
 *
 * The `KVStore` mock keeps each store in
 * `.cdk-blocks/local/data/<fullId>/store.json`, as `{ "version": 2, "items":
 * [...] }`, where every entry is the item exactly as the deployed table holds
 * it. For this store that is the record itself: the table is keyed on the
 * record's own `pk` / `sk`, so nothing is added around it. The mock reads the
 * file once, when the dev server constructs the store, and writes it whole on
 * every write — so a script must only touch it while no dev server runs, or
 * the server's next write drops what the script wrote.
 *
 * The scripts go through the file rather than through the block because the
 * e2e suite imports them in the browser build of the backend, where the block
 * has no data methods.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Item } from '../model.js';

/** Keyed by the scope and table id in `resources.ts`. */
export const LOCAL_TABLE_FILE = join(
  process.cwd(),
  '.cdk-blocks',
  'local',
  'data',
  'sl-wiki-permissions',
  'store.json',
);

/** The format version this file is written in. Any other version is refused. */
const FILE_VERSION = 2;

/** The records of the local table, by `JSON.stringify([pk, sk])`. */
export type LocalTable = {
  items: Map<string, Item>;
  /** Writes every record back, in the mock's format. */
  flush(): void;
};

export const localKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);

/**
 * The local table, or an error that says how to get one.
 *
 * A file of an earlier release (`.bb-data/`, or a `store.json` without a
 * version) is converted by the mock the first time the dev server opens the
 * store, so the way forward from either is to start the server once.
 */
export function openLocalTable(missing: string): LocalTable {
  if (!existsSync(LOCAL_TABLE_FILE)) {
    throw new Error(`${LOCAL_TABLE_FILE} does not exist.\n${missing}`);
  }
  const parsed = JSON.parse(readFileSync(LOCAL_TABLE_FILE, 'utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== FILE_VERSION ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error(
      `${LOCAL_TABLE_FILE} is not in the format this script writes (version ${FILE_VERSION}). ` +
        'Start `pnpm run dev` once so the mock converts it, stop it, and re-run this.',
    );
  }
  const items = new Map(
    ((parsed as { items: Item[] }).items).map((item) => [localKey(item.pk, item.sk), item]),
  );
  return {
    items,
    flush() {
      writeFileSync(
        LOCAL_TABLE_FILE,
        `${JSON.stringify({ version: FILE_VERSION, items: [...items.values()] }, null, 2)}\n`,
      );
    },
  };
}

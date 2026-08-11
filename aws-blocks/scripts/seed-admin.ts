/**
 * Seed the first global administrator.
 *
 * The Wiki has no API that raises anyone's own permissions, so the first
 * administrator is four records an operator writes straight into the table:
 * the `ug_admins` user group, the `rg_global_admin` role group, the attachment
 * between them, and one membership pointing at the operator's Cognito `sub`.
 * A fifth write moves the permission epoch, so warm Lambdas holding a cached
 * "no permissions" answer for this account pick the change up immediately.
 *
 *   AWS:    AWS_PROFILE=<profile> pnpm run seed-admin -- --table <name> --email you@example.com
 *   local:  pnpm run seed-admin -- --local --email admin@example.test
 *
 * The `sub` comes out of the table itself, not out of Cognito: the first
 * sign-in writes `USER#<sub>` / `PROFILE` with the lower-cased address in
 * `gsi1sk`, so one index read finds it. The person therefore has to
 * have signed in once before this runs.
 *
 * Every write is conditional on the record being absent, so re-running fills in
 * only what is missing and never overwrites an edge someone edited since. That
 * also makes this the way back from an environment whose last administrator was
 * removed; it does not refuse to run when administrators already exist.
 *
 * Only `model.ts` knows how keys are spelled. This script calls the same
 * builders the API does, so a change to the key design cannot leave the seeding
 * behind — which matters because a mistyped `gsi1sk` raises no error at all. It
 * drops one edge out of the three-hop traversal, and the symptom is an
 * administrator who signs in and sees no spaces.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isServerRunning } from '@aws-blocks/blocks/utils';

import {
  ALL_ROLE_GROUPS,
  ALL_USERS,
  ALL_USER_GROUPS,
  CONFIG_EPOCH,
  CONFIG_PK,
  META,
  PROFILE,
  SYSTEM_ADMIN_ROLE_GROUP,
  SYSTEM_ADMIN_USER_GROUP,
  type Item,
  idOf,
  itemSchema,
  roleGroupPk,
  sortable,
  userGroupPk,
  userPk,
} from '../model.js';

/**
 * Is something still serving on the dev port?
 *
 * `isServerRunning()` answers `false` when nothing is listening, but throws when
 * the connection is accepted and then reset, which is what a server in the
 * middle of shutting down does. A throw therefore means "something is still
 * there", so it is reported as running rather than allowed to escape.
 */
export async function devServerIsUp(): Promise<boolean> {
  try {
    return await isServerRunning();
  } catch {
    return true;
  }
}

/** The mock's data file, keyed by the scope and table id in `resources.ts`. */
const LOCAL_DATA_FILE = join(process.cwd(), '.bb-data', 'sl-wiki-permissions', 'data.json');

/** The mock serialises a primary key as `JSON.stringify([pk, sk])`. */
const localKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);

/**
 * The four records that make one account a global administrator.
 *
 * Validated against `itemSchema` before anything is written, so a mistake here
 * surfaces as a parse error rather than as a half-seeded table.
 */
export function adminRecords(userSub: string, at: string): Item[] {
  const records = [
    {
      pk: userGroupPk(SYSTEM_ADMIN_USER_GROUP),
      sk: META,
      type: 'USER_GROUP',
      gsi1pk: ALL_USER_GROUPS,
      gsi1sk: sortable('Administrators'),
      name: 'Administrators',
      description: 'Members hold every management permission.',
      system: true,
      createdAt: at,
      version: 0,
    },
    {
      pk: roleGroupPk(SYSTEM_ADMIN_ROLE_GROUP),
      sk: META,
      type: 'ROLE_GROUP',
      gsi1pk: ALL_ROLE_GROUPS,
      gsi1sk: sortable('Global administrator'),
      name: 'Global administrator',
      description: 'Administrator on every space, present and future.',
      system: true,
      global: true,
      createdAt: at,
      version: 0,
    },
    {
      pk: userGroupPk(SYSTEM_ADMIN_USER_GROUP),
      sk: roleGroupPk(SYSTEM_ADMIN_ROLE_GROUP),
      type: 'ATTACHMENT',
      gsi1pk: roleGroupPk(SYSTEM_ADMIN_ROLE_GROUP),
      gsi1sk: userGroupPk(SYSTEM_ADMIN_USER_GROUP),
      addedAt: at,
      addedBy: userSub,
    },
    {
      pk: userPk(userSub),
      sk: userGroupPk(SYSTEM_ADMIN_USER_GROUP),
      type: 'MEMBERSHIP',
      gsi1pk: userGroupPk(SYSTEM_ADMIN_USER_GROUP),
      gsi1sk: userPk(userSub),
      addedAt: at,
      addedBy: userSub,
    },
  ];
  return records.map((record) => itemSchema.parse(record));
}

/**
 * A new generation of the permission epoch, shaped exactly like the record
 * `bumpEpoch()` in `access.ts` writes. Duplicated here because importing
 * `access.ts` would drag the whole Lambda runtime into this standalone script.
 *
 * Without this write, a warm Lambda that has already resolved "no permissions"
 * for this account keeps serving that cached answer until its TTL runs out,
 * and the freshly seeded administrator stays locked out for up to five minutes.
 */
export function epochRecord(at: string): Item {
  return itemSchema.parse({
    pk: CONFIG_PK,
    sk: CONFIG_EPOCH,
    type: 'EPOCH',
    epoch: `${at}#${randomUUID()}`,
  });
}

/**
 * Where the records go. The two implementations differ only in how they read
 * one index and write one item; everything above them is shared.
 */
type Store = {
  /** The `sub` of the account that signed in with this address, or `null`. */
  findUserSub(email: string): Promise<string | null>;
  /** Writes unless the key is taken. `false` means the record was already there. */
  putIfAbsent(record: Item): Promise<boolean>;
  /** Last-writer-wins write; the epoch record is meant to be overwritten. */
  put(record: Item): Promise<void>;
};

// ─── Local mock ──────────────────────────────────────────────────────────────

function localStore(): Store {
  if (!existsSync(LOCAL_DATA_FILE)) {
    throw new Error(
      `${LOCAL_DATA_FILE} does not exist.\n` +
        'Run `pnpm run dev`, sign up, sign in once, then stop the server and re-run this.',
    );
  }
  const entries = JSON.parse(readFileSync(LOCAL_DATA_FILE, 'utf8')) as [string, Item][];
  const data = new Map(entries);
  const flush = () => writeFileSync(LOCAL_DATA_FILE, `${JSON.stringify([...data], null, 2)}\n`);

  return {
    async findUserSub(email) {
      const wanted = sortable(email);
      for (const item of data.values()) {
        if (item.type === 'USER' && item.sk === PROFILE && item.gsi1sk === wanted) {
          return idOf(item.pk);
        }
      }
      return null;
    },
    async putIfAbsent(record) {
      const key = localKey(record.pk, record.sk);
      if (data.has(key)) return false;
      data.set(key, record);
      flush();
      return true;
    },
    async put(record) {
      data.set(localKey(record.pk, record.sk), record);
      flush();
    },
  };
}

// ─── Deployed table ──────────────────────────────────────────────────────────

const run = promisify(execFile);

/**
 * One AWS CLI call, parsed as JSON.
 *
 * The CLI is used rather than the SDK so this script adds no dependency: the
 * operator running it already has credentials configured for `aws`.
 */
async function awsCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run('aws', [...args, '--output', 'json']);
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

/** DynamoDB's wire format, for the three value kinds these records use. */
function marshal(record: Item): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([field, value]) => {
      if (typeof value === 'string') return [field, { S: value }];
      if (typeof value === 'boolean') return [field, { BOOL: value }];
      if (typeof value === 'number') return [field, { N: String(value) }];
      throw new Error(`Cannot marshal ${field}: ${typeof value}`);
    }),
  );
}

function awsStore(tableName: string): Store {
  return {
    async findUserSub(email) {
      const result = await awsCli([
        'dynamodb',
        'query',
        '--table-name',
        tableName,
        '--index-name',
        'gsi1',
        '--key-condition-expression',
        'gsi1pk = :pk AND gsi1sk = :sk',
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: ALL_USERS }, ':sk': { S: sortable(email) } }),
      ]);
      const items = (result.Items ?? []) as { pk?: { S?: string }; sk?: { S?: string } }[];
      const profile = items.find((item) => item.sk?.S === PROFILE);
      return profile?.pk?.S === undefined ? null : idOf(profile.pk.S);
    },
    async putIfAbsent(record) {
      try {
        await awsCli([
          'dynamodb',
          'put-item',
          '--table-name',
          tableName,
          '--item',
          JSON.stringify(marshal(record)),
          '--condition-expression',
          'attribute_not_exists(pk)',
        ]);
        return true;
      } catch (error) {
        // The CLI reports a refused condition as a non-zero exit, which is the
        // expected outcome of a re-run, not a failure.
        if (String(error).includes('ConditionalCheckFailedException')) return false;
        throw error;
      }
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

/** Write the four records, reporting which of them were missing. */
export async function seed(
  store: Store,
  email: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  const userSub = await store.findUserSub(email);
  if (userSub === null) {
    throw new Error(
      `No account has signed in with ${email}.\n` +
        'The sub is read from the profile record the first sign-in writes, so sign in once first.',
    );
  }
  log(`sub: ${userSub}`);

  let written = 0;
  for (const record of adminRecords(userSub, new Date().toISOString())) {
    const created = await store.putIfAbsent(record);
    if (created) written += 1;
    log(`  ${record.pk} / ${record.sk}${created ? '' : '  (already present)'}`);
  }
  if (written === 0) {
    log('Nothing to do: this account is already a global administrator.');
    return;
  }
  // The permissions changed, so the epoch has to move, the same as the API
  // does after every permission edit. Warm Lambdas drop their cached walks
  // only when they see a new generation.
  await store.put(epochRecord(new Date().toISOString()));
  log(`  ${CONFIG_PK} / ${CONFIG_EPOCH}  (new generation)`);
  log(`Wrote ${written} record(s). Sign in again; the permission check runs per request.`);
}

/**
 * Seed the local mock.
 *
 * Exported for the e2e suite, which stops the dev server itself and so does not
 * need the running-server guard `main()` applies.
 */
export const seedLocal = (email: string, log?: (line: string) => void) =>
  seed(localStore(), email, log);

function usage(): never {
  console.error(
    'Usage:\n' +
      '  pnpm run seed-admin -- --table <table-name> --email <address>   (deployed stack)\n' +
      '  pnpm run seed-admin -- --local --email <address>                (local mock)\n' +
      '\n' +
      'Find the table name with: aws dynamodb list-tables',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const email = valueOf('--email');
  const tableName = valueOf('--table');
  const local = args.includes('--local');

  if (email === undefined || local === (tableName !== undefined)) usage();

  if (local) {
    // The mock reads this file once at start-up and rewrites it whole on every
    // write, so a change made underneath a running server is dropped by its next
    // write. Refusing here beats a seeding that silently disappears.
    if (await devServerIsUp()) {
      console.error('The dev server is running. Stop it, re-run this, then start it again.');
      process.exit(1);
    }
    await seedLocal(email);
    return;
  }

  await seed(awsStore(tableName as string), email);
}

// Guarded so the e2e suite can import `seed` without the CLI running too.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

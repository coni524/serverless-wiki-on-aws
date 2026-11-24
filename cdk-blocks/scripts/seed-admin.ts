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
 *           AWS_PROFILE=<profile> pnpm run seed-admin -- --table <name> --sub <sub>
 *   local:  pnpm run seed-admin -- --local --email admin@example.test
 *           pnpm run seed-admin -- --local --sub <sub>
 *
 * The `sub` comes out of the table itself, not out of Cognito: the first
 * sign-in writes `USER#<sub>` / `PROFILE` with the lower-cased address in
 * `gsi1sk`, so one index read finds it. The person therefore has to
 * have signed in once before this runs.
 *
 * An address alone is not an identity, so `--email` chooses only among
 * password accounts. Those are created by the operator (the pool takes no
 * sign-ups), so their address is one the operator vouched for. A federated
 * account's address is whatever its IdP asserted, and a second IdP, or a user
 * who can edit their own address there, can assert anyone's. Such an account is
 * therefore never chosen by address: the operator confirms whose account it is
 * outside this script and names it with `--sub`, which is also how a federated
 * administrator is brought back after an IdP misconfiguration locks everyone
 * out. When the address matches more than one password account, or only
 * federated ones, nothing is written and the candidates are listed instead.
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isServerRunning } from 'aws-cdk-blocks/utils';

import { localKey, openLocalTable } from './local-table.js';

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
 * `bumpEpoch()` in `epoch.ts` writes. Duplicated here because importing
 * `epoch.ts` would drag the whole Lambda runtime into this standalone script.
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

/** One directory record, as much of it as choosing whom to promote needs. */
export type Profile = {
  sub: string;
  email: string;
  /** The external IdP that signed this account in; absent for a password account. */
  identityProvider?: string;
};

/**
 * Whom to promote: a password account by its address, or any account by the
 * `sub` the operator confirmed.
 */
export type Target = { email: string } | { sub: string };

/**
 * Where the records go. The two implementations differ only in how they read
 * and write items; everything above them is shared.
 */
export type Store = {
  /** Every directory record whose address is `email`, read off the index. */
  profilesByEmail(email: string): Promise<Profile[]>;
  /** The directory record of this `sub`, or `null`. */
  profileBySub(sub: string): Promise<Profile | null>;
  /** Writes unless the key is taken. `false` means the record was already there. */
  putIfAbsent(record: Item): Promise<boolean>;
  /** Last-writer-wins write; the epoch record is meant to be overwritten. */
  put(record: Item): Promise<void>;
};

// ─── Local mock ──────────────────────────────────────────────────────────────

/** The fields of a directory record that `Profile` carries. */
function profileOf(item: Item): Profile {
  return {
    sub: idOf(item.pk),
    email: item.email ?? '',
    ...(item.identityProvider !== undefined ? { identityProvider: item.identityProvider } : {}),
  };
}

function localStore(): Store {
  const { items: data, flush } = openLocalTable(
    'Run `pnpm run dev`, sign up, sign in once, then stop the server and re-run this.',
  );

  return {
    async profilesByEmail(email) {
      const wanted = sortable(email);
      return [...data.values()]
        .filter((item) => item.type === 'USER' && item.sk === PROFILE && item.gsi1sk === wanted)
        .map(profileOf);
    },
    async profileBySub(sub) {
      const item = data.get(localKey(userPk(sub), PROFILE));
      return item?.type === 'USER' ? profileOf(item) : null;
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

/** A directory record in DynamoDB's wire format, as far as `Profile` reads it. */
type WireProfile = {
  pk?: { S?: string };
  sk?: { S?: string };
  email?: { S?: string };
  identityProvider?: { S?: string };
};

/** The `Profile` of a wire-format item, or `null` when it is not a directory record. */
function wireProfileOf(item: WireProfile): Profile | null {
  if (item.sk?.S !== PROFILE || item.pk?.S === undefined) return null;
  const identityProvider = item.identityProvider?.S;
  return {
    sub: idOf(item.pk.S),
    email: item.email?.S ?? '',
    ...(identityProvider !== undefined ? { identityProvider } : {}),
  };
}

function awsStore(tableName: string): Store {
  return {
    async profilesByEmail(email) {
      // One partition of the index, every page of it: the CLI follows
      // `LastEvaluatedKey` itself, so no matching record is left unread.
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
      return ((result.Items ?? []) as WireProfile[])
        .map(wireProfileOf)
        .filter((profile): profile is Profile => profile !== null);
    },
    async profileBySub(sub) {
      const result = await awsCli([
        'dynamodb',
        'get-item',
        '--table-name',
        tableName,
        '--key',
        JSON.stringify({ pk: { S: userPk(sub) }, sk: { S: PROFILE } }),
        '--consistent-read',
      ]);
      const item = result.Item as WireProfile | undefined;
      return item === undefined ? null : wireProfileOf(item);
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

// ─── Choosing the account ────────────────────────────────────────────────────

/** How a candidate reads in a listing: its sub, how it signs in, its address. */
const describe = (profile: Profile) =>
  `  ${profile.sub}  ${profile.identityProvider ?? 'password'}  ${profile.email}`;

/**
 * The one account `email` may promote, or an error that lists the candidates.
 *
 * Only a password account is chosen by address, and only when it is the one
 * password account with that address. A federated record with the same address
 * is never a reason to pick it, and never a reason to refuse the password
 * account either: the scenario this guards against is exactly someone else's
 * IdP asserting the operator's address.
 */
export function chooseByEmail(email: string, profiles: Profile[]): Profile {
  if (profiles.length === 0) {
    throw new Error(
      `No account has signed in with ${email}.\n` +
        'The sub is read from the profile record the first sign-in writes, so sign in once first.',
    );
  }
  const password = profiles.filter((profile) => profile.identityProvider === undefined);
  const federated = profiles.filter((profile) => profile.identityProvider !== undefined);

  if (password.length === 1) return password[0]!;

  if (password.length > 1) {
    throw new Error(
      `${password.length} password accounts have signed in with ${email}, so the address ` +
        'does not say which one to promote. Nothing was written.\n' +
        'Candidates (sub, sign-in, address):\n' +
        `${profiles.map(describe).join('\n')}\n` +
        'Confirm in the Cognito console which sub belongs to the person, then re-run with ' +
        '--sub <sub> in place of --email.',
    );
  }

  throw new Error(
    `Only federated accounts have signed in with ${email}. Nothing was written.\n` +
      'A federated account is never chosen by address: the address is what its IdP ' +
      'asserted, and another IdP, or a user who can edit their own address there, can ' +
      'assert the same one.\n' +
      'Candidates (sub, sign-in, address):\n' +
      `${federated.map(describe).join('\n')}\n` +
      "Confirm whose account each one is: in the Cognito console the user's name is " +
      '<registration name>_<sub at the IdP>; check that sub against the IdP, then re-run ' +
      'with --sub <sub> in place of --email.',
  );
}

/** The account the target names, after the checks above. */
async function chooseAccount(
  store: Store,
  target: Target,
  log: (line: string) => void,
): Promise<Profile> {
  if ('sub' in target) {
    const profile = await store.profileBySub(target.sub);
    if (profile === null) {
      throw new Error(
        `No profile record exists for sub ${target.sub}.\n` +
          'The record is written by the first sign-in, so the person has to sign in once first.',
      );
    }
    return profile;
  }

  const profiles = await store.profilesByEmail(target.email);
  const chosen = chooseByEmail(target.email, profiles);
  const skipped = profiles.filter((profile) => profile !== chosen);
  if (skipped.length > 0) {
    log('Not considered (federated accounts are chosen only with --sub):');
    for (const profile of skipped) log(describe(profile));
  }
  return chosen;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Write the four records, reporting which of them were missing. */
export async function seed(
  store: Store,
  target: Target,
  log: (line: string) => void = console.log,
): Promise<void> {
  const profile = await chooseAccount(store, target, log);
  const userSub = profile.sub;
  // Shown before anything is written, so an operator who named the wrong
  // account sees whose it is in the same output that reports the writes.
  log(`sub: ${userSub}`);
  log(`email: ${profile.email}`);
  log(`sign-in: ${profile.identityProvider ?? 'password'}`);

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
export const seedLocal = (target: Target, log?: (line: string) => void) =>
  seed(localStore(), target, log);

function usage(): never {
  console.error(
    'Usage:\n' +
      '  pnpm run seed-admin -- --table <table-name> --email <address>   (deployed stack)\n' +
      '  pnpm run seed-admin -- --table <table-name> --sub <sub>         (deployed stack)\n' +
      '  pnpm run seed-admin -- --local --email <address>                (local mock)\n' +
      '  pnpm run seed-admin -- --local --sub <sub>                      (local mock)\n' +
      '\n' +
      'Give exactly one of --email and --sub.\n' +
      '  --email  chooses a password account, and only when exactly one has that address.\n' +
      '  --sub    names any account, federated ones included. A federated account is\n' +
      '           never chosen by address: confirm whose account the sub is first.\n' +
      '\n' +
      'Find the table name with: aws dynamodb list-tables',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    const value = args[at + 1];
    // A missing value, or the next flag where the value should be, is a typo.
    return value === undefined || value.startsWith('--') || value.trim() === '' ? usage() : value;
  };
  const email = valueOf('--email');
  const sub = valueOf('--sub');
  const tableName = valueOf('--table');
  const local = args.includes('--local');

  if ((email === undefined) === (sub === undefined) || local === (tableName !== undefined)) usage();
  const target: Target = sub !== undefined ? { sub } : { email: email as string };

  if (local) {
    // The mock reads its file once at start-up and rewrites it whole on every
    // write, so a change made underneath a running server is dropped by its next
    // write (`local-table.ts`). Refusing here beats a seeding that silently
    // disappears.
    if (await devServerIsUp()) {
      console.error('The dev server is running. Stop it, re-run this, then start it again.');
      process.exit(1);
    }
    await seedLocal(target);
    return;
  }

  await seed(awsStore(tableName as string), target);
}

// Guarded so the e2e suite can import `seed` without the CLI running too.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

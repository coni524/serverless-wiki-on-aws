/**
 * Add an account to the user pool of the local dev server.
 *
 *   pnpm run local:add-user -- --email you@example.test [--password <password>]
 *
 * Sign-up is closed on every pool this app creates, the local one included, so
 * an account has to exist before anyone signs in with it — on AWS an operator
 * creates it with the AWS CLI, and locally this script does. It writes a
 * confirmed account with no second factor enrolled yet: the first sign-in asks
 * for an authenticator, as it does for an account an administrator created on
 * AWS. Without `--password`, one is generated and printed.
 *
 * The local pool keeps its state in `.cdk-blocks/local/data/<fullId>/state.json`,
 * `{ users, groups, codes, challenges, sessionSecret }`, with each user keyed
 * by its `userSub` on a pool that signs in with email. The dev server reads the
 * file once at start-up and rewrites it whole on every change, so the script
 * refuses to run while a dev server is up: its next write would drop the
 * account. The file is written rather than going through the block because
 * creating users through the block needs its admin grant, which would also
 * give the deployed function the right to create users.
 *
 * The e2e suite imports `addLocalUser` to provision its accounts before it
 * starts the dev server.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { devServerIsUp } from './seed-admin.js';

/** Keyed by the scope and the `Auth` block id in `resources.ts`. */
const POOL_DIR = join('.cdk-blocks', 'local', 'data', 'sl-wiki-auth');

/**
 * The password rules of the pool in `resources.ts`. The local pool checks
 * them only on the calls that set a password, which this file bypasses, so
 * they are checked here: an account the deployed pool could not hold must not
 * exist locally either.
 */
function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'an uppercase letter';
  if (!/[a-z]/.test(password)) return 'a lowercase letter';
  if (!/[0-9]/.test(password)) return 'a digit';
  if (!/[^A-Za-z0-9]/.test(password)) return 'a symbol';
  return null;
}

function generatedPassword(): string {
  // Base64url plus one character of each required class.
  return `${randomBytes(12).toString('base64url')}Aa1!`;
}

type PoolState = { users: Record<string, LocalUser>; groups: Record<string, unknown> } & Record<
  string,
  unknown
>;
type LocalUser = { userSub: string; attributes?: Record<string, string> } & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readPool(file: string): PoolState {
  if (!existsSync(file)) return { users: {}, groups: {} };
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(raw) || !isRecord(raw.users) || !isRecord(raw.groups)) {
    // Fail loudly: the pool drops records it cannot read without an error, so
    // writing into a format that changed would create an account nobody can
    // sign in with.
    throw new Error(
      `${file} is not the local pool format this script writes ({ users, groups, ... }). ` +
        'The local user pool of AWS CDK Blocks may have changed; update cdk-blocks/scripts/local-users.ts.',
    );
  }
  return raw as PoolState;
}

/**
 * Create a confirmed local account, or leave an existing one as it is.
 *
 * The caller must make sure no dev server is running.
 */
export function addLocalUser(
  email: string,
  password: string,
  cwd: string = process.cwd(),
): { userSub: string; created: boolean } {
  const problem = passwordProblem(password);
  if (problem !== null) throw new Error(`The password needs ${problem}.`);

  const dir = join(cwd, POOL_DIR);
  const file = join(dir, 'state.json');
  const pool = readPool(file);
  const address = email.trim().toLowerCase();

  const existing = Object.values(pool.users).find(
    (user) => user.attributes?.email?.toLowerCase() === address,
  );
  if (existing) return { userSub: existing.userSub, created: false };

  const userSub = randomUUID();
  pool.users[userSub] = {
    userSub,
    password,
    confirmed: true,
    disabled: false,
    attributes: { email: address, email_verified: 'true' },
    mfaPreference: { enabled: [] },
    totpVerified: false,
    devices: {},
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(pool, null, 2));
  renameSync(tmp, file);
  return { userSub, created: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const email = valueOf('--email');
  if (email === undefined || !email.includes('@')) {
    console.error('Usage: pnpm run local:add-user -- --email <address> [--password <password>]');
    process.exit(1);
  }
  if (await devServerIsUp()) {
    console.error('The dev server is running. Stop it, re-run this, then start it again.');
    process.exit(1);
  }
  const given = valueOf('--password');
  const password = given ?? generatedPassword();
  const { userSub, created } = addLocalUser(email, password);
  if (!created) {
    console.log(`${email} already has a local account (sub ${userSub}). Nothing was changed.`);
    return;
  }
  console.log(`Created ${email} (sub ${userSub}).`);
  if (given === undefined) console.log(`Password: ${password}`);
  console.log('The first sign-in asks you to set up an authenticator app; locally any 6 digits pass.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

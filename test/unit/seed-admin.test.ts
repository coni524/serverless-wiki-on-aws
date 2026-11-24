/**
 * Unit tests for how `seed-admin` chooses the account it promotes.
 *
 * An address is not an identity: a federated account's address is whatever its
 * IdP asserted. These tests pin the rule that keeps an asserted address from
 * choosing who becomes a global administrator, against an in-memory store.
 *
 * Run with: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Profile, type Store, chooseByEmail, seed } from '../../cdk-blocks/scripts/seed-admin.js';

const OPS = 'ops@corp.example';

const password = (sub: string, email = OPS): Profile => ({ sub, email });
const federated = (sub: string, provider: string, email = OPS): Profile => ({
  sub,
  email,
  identityProvider: provider,
});

/** A store holding `profiles`, recording which `sub` got a membership. */
function memoryStore(profiles: Profile[]) {
  const members: string[] = [];
  let writes = 0;
  const store: Store = {
    async profilesByEmail(email) {
      return profiles.filter((profile) => profile.email.toLowerCase() === email.toLowerCase());
    },
    async profileBySub(sub) {
      return profiles.find((profile) => profile.sub === sub) ?? null;
    },
    async putIfAbsent(record) {
      writes += 1;
      if (record.type === 'MEMBERSHIP') members.push(record.pk.slice('USER#'.length));
      return true;
    },
    async put() {
      writes += 1;
    },
  };
  return { store, members, writes: () => writes };
}

/** Run `fn` and return the message it threw. */
async function thrown(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('Expected a refusal');
}

// ─── chooseByEmail ───────────────────────────────────────────────────────────

test('the one password account with the address is chosen', () => {
  assert.equal(chooseByEmail(OPS, [password('sub-ops')]).sub, 'sub-ops');
});

test('a federated account asserting the same address is never chosen over it', () => {
  // Whatever order the index returns them in, the password account wins.
  const ops = password('sub-ops');
  const intruder = federated('sub-intruder', 'partner');
  assert.equal(chooseByEmail(OPS, [intruder, ops]).sub, 'sub-ops');
  assert.equal(chooseByEmail(OPS, [ops, intruder]).sub, 'sub-ops');
});

test('no account with the address says to sign in first', () => {
  assert.throws(() => chooseByEmail(OPS, []), /signed in/);
});

test('two password accounts with the address are refused and listed', () => {
  assert.throws(
    () => chooseByEmail(OPS, [password('sub-a'), password('sub-b')]),
    (error: Error) =>
      error.message.includes('sub-a') &&
      error.message.includes('sub-b') &&
      error.message.includes('password') &&
      error.message.includes('--sub'),
  );
});

test('a lone federated account is not chosen by address', () => {
  assert.throws(
    () => chooseByEmail(OPS, [federated('sub-fed', 'corp')]),
    (error: Error) =>
      error.message.includes('sub-fed') &&
      error.message.includes('corp') &&
      error.message.includes('--sub'),
  );
});

test('several federated accounts are listed with their providers', () => {
  assert.throws(
    () => chooseByEmail(OPS, [federated('sub-ours', 'corp'), federated('sub-theirs', 'partner')]),
    (error: Error) =>
      ['sub-ours', 'corp', 'sub-theirs', 'partner'].every((part) => error.message.includes(part)),
  );
});

// ─── seed ────────────────────────────────────────────────────────────────────

test('seeding by address promotes the password account, not the federated one', async () => {
  const { store, members } = memoryStore([federated('sub-intruder', 'partner'), password('sub-ops')]);
  const lines: string[] = [];
  await seed(store, { email: OPS }, (line) => lines.push(line));
  assert.deepEqual(members, ['sub-ops']);
  assert.ok(lines.some((line) => line.includes('sub-intruder')), 'The skipped account is reported');
});

test('seeding by address writes nothing when only federated accounts match', async () => {
  const { store, writes } = memoryStore([federated('sub-intruder', 'partner')]);
  const message = await thrown(() => seed(store, { email: OPS }, () => {}));
  assert.match(message, /--sub/);
  assert.equal(writes(), 0);
});

test('seeding by sub promotes a federated account and shows whose it is first', async () => {
  // The way back after an IdP misconfiguration locks every administrator out.
  const { store, members } = memoryStore([federated('sub-fed', 'corp'), password('sub-other')]);
  const lines: string[] = [];
  await seed(store, { sub: 'sub-fed' }, (line) => lines.push(line));
  assert.deepEqual(members, ['sub-fed']);
  const firstWrite = lines.findIndex((line) => line.startsWith('  '));
  for (const shown of ['sub-fed', OPS, 'corp']) {
    const at = lines.findIndex((line) => line.includes(shown));
    assert.ok(at !== -1 && at < firstWrite, `${shown} is shown before anything is written`);
  }
});

test('seeding by a sub with no profile is refused', async () => {
  const { store, writes } = memoryStore([password('sub-ops')]);
  const message = await thrown(() => seed(store, { sub: 'sub-nobody' }, () => {}));
  assert.match(message, /sub-nobody/);
  assert.equal(writes(), 0);
});

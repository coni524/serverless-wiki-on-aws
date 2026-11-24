/**
 * Bringing a federated account's role groups up to date with its IdP, and the
 * bearer door's checks around it.
 *
 * Both run against small in-memory stand-ins for the table and the user pool,
 * because what is worth testing is the ordering: which sign-in may write, who
 * holds the record, what happens to a run that fails half-way, and which
 * requests the bearer door turns away.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  FEDERATED_SIGN_IN_MAX_AGE_SECONDS,
  type GateDeps,
  type PoolUser,
  Refusal,
  federatedGate,
  registrationsOf,
} from '../../cdk-blocks/bearer-auth.js';
import {
  NoAccessError,
  SyncBusyError,
  type SyncStore,
  authTimeOf,
  syncIdpGroups,
} from '../../cdk-blocks/federation.js';
import type { Item } from '../../cdk-blocks/model.js';

const USER = 'u-1';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const roleGroup = (id: string, group: string): Item => ({
  pk: `RG#${id}`,
  sk: 'META',
  type: 'ROLE_GROUP',
  name: id,
  gsi1pk: 'RG',
  gsi1sk: id,
  idpGroups: [{ provider: 'sso', group }],
});

const edge = (roleGroupId: string): Item => ({
  pk: `USER#${USER}`,
  sk: `RG#${roleGroupId}`,
  type: 'ROLE_MEMBERSHIP',
  gsi1pk: `RG#${roleGroupId}`,
  gsi1sk: `USER#${USER}`,
});

const membership = (userGroupId: string): Item => ({
  pk: `USER#${USER}`,
  sk: `UG#${userGroupId}`,
  type: 'MEMBERSHIP',
});

const profile: Item = {
  pk: `USER#${USER}`,
  sk: 'PROFILE',
  type: 'USER',
  email: 'a@example.com',
  identityProvider: 'sso',
};

/** A table in a Map, with the conditional write the record relies on. */
class MemoryStore implements SyncStore {
  readonly items = new Map<string, Item>();
  epochBumps = 0;
  profileWrites = 0;
  clock = NOW_MS;
  /** Runs once, just before the next conditional record write is judged. */
  beforeRecordWrite: (() => void) | undefined;

  constructor(seed: Item[]) {
    for (const item of [roleGroup('editors', 'wiki-editors'), roleGroup('readers', 'wiki-readers'), ...seed]) {
      this.items.set(`${item.pk}|${item.sk}`, item);
    }
  }

  record(): Item | undefined {
    return this.items.get(`USER#${USER}|IDP_SYNC`);
  }

  edges(): string[] {
    return [...this.items.values()]
      .filter((item) => item.pk === `USER#${USER}` && item.type === 'ROLE_MEMBERSHIP')
      .map((item) => item.sk)
      .sort();
  }

  async readRecord(userId: string) {
    const item = this.items.get(`USER#${userId}|IDP_SYNC`);
    return item === undefined ? undefined : { ...item };
  }

  async writeRecord(record: Item, expected: number | undefined) {
    const hook = this.beforeRecordWrite;
    this.beforeRecordWrite = undefined;
    hook?.();
    const current = this.items.get(`${record.pk}|${record.sk}`);
    if (expected === undefined ? current !== undefined : current?.version !== expected) return false;
    this.items.set(`${record.pk}|${record.sk}`, { ...record });
    return true;
  }

  async readOwn(userId: string) {
    return [...this.items.values()].filter((item) => item.pk === `USER#${userId}`).map((item) => ({ ...item }));
  }

  async readRoleGroups() {
    return [...this.items.values()].filter((item) => item.type === 'ROLE_GROUP');
  }

  async deleteEdge(userId: string, roleGroupId: string) {
    this.items.delete(`USER#${userId}|RG#${roleGroupId}`);
  }

  async putEdge(item: Item) {
    this.items.set(`${item.pk}|${item.sk}`, item);
  }

  async writeProfile() {
    this.profileWrites += 1;
  }

  async bumpEpoch() {
    this.epochBumps += 1;
  }

  now() {
    return this.clock;
  }

  async sleep(ms: number) {
    this.clock += ms;
  }
}

const sync = (store: MemoryStore, authTime: number, groups: string[]) =>
  syncIdpGroups({ userId: USER, authTime, load: async () => ({ provider: 'sso', groups }) }, store);

// ─── syncIdpGroups ───────────────────────────────────────────────────────────

test('a first sign-in writes its edges and records its time', async () => {
  const store = new MemoryStore([]);
  const result = await sync(store, 100, ['wiki-editors']);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.changed, true);
  assert.deepStrictEqual(store.edges(), ['RG#editors']);
  assert.strictEqual(store.record()?.syncedAuthTime, 100);
  assert.strictEqual(store.record()?.leaseUntil, undefined);
  assert.deepStrictEqual(
    result.own.filter((item) => item.type === 'ROLE_MEMBERSHIP').map((item) => item.sk),
    ['RG#editors'],
  );
});

test('a group taken away at the IdP removes the edge', async () => {
  const store = new MemoryStore([edge('editors'), edge('readers')]);
  await sync(store, 100, ['wiki-readers']);
  assert.deepStrictEqual(store.edges(), ['RG#readers']);
});

test('an older sign-in arriving late does not put back a removed edge', async () => {
  const store = new MemoryStore([edge('editors')]);
  await sync(store, 200, ['wiki-readers']);
  const late = await sync(store, 150, ['wiki-editors']);
  assert.strictEqual(late.applied, false);
  assert.deepStrictEqual(store.edges(), ['RG#readers']);
  assert.strictEqual(store.record()?.syncedAuthTime, 200);
});

test('the same sign-in is not applied twice', async () => {
  const store = new MemoryStore([]);
  await sync(store, 100, ['wiki-editors']);
  let loaded = false;
  const again = await syncIdpGroups(
    {
      userId: USER,
      authTime: 100,
      load: async () => {
        loaded = true;
        return { provider: 'sso', groups: [] };
      },
    },
    store,
  );
  assert.strictEqual(again.applied, false);
  assert.strictEqual(loaded, false, 'the groups are not read for a sign-in already applied');
});

test('nothing changed means the epoch does not move', async () => {
  const store = new MemoryStore([edge('editors')]);
  const result = await sync(store, 100, ['wiki-editors']);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(store.epochBumps, 0);
});

test('an empty group list keeps a membership granted in the Wiki', async () => {
  const store = new MemoryStore([edge('editors'), membership('ug_admins')]);
  const result = await sync(store, 100, []);
  assert.deepStrictEqual(store.edges(), []);
  assert.ok(result.own.some((item) => item.type === 'MEMBERSHIP'));
});

test('a sync down to nothing removes first, records the time, then refuses', async () => {
  const store = new MemoryStore([edge('editors')]);
  await assert.rejects(sync(store, 100, []), NoAccessError);
  assert.deepStrictEqual(store.edges(), [], 'the removal still lands');
  assert.strictEqual(store.epochBumps, 1);
  assert.strictEqual(store.record()?.syncedAuthTime, 100);
  assert.strictEqual(store.record()?.leaseUntil, undefined);
});

test('a lease held by somebody else is waited for, then busy', async () => {
  const store = new MemoryStore([
    { pk: `USER#${USER}`, sk: 'IDP_SYNC', type: 'IDP_SYNC', syncedAuthTime: 50, version: 3, leaseUntil: NOW_MS + 60 * 60 * 1000 },
  ]);
  await assert.rejects(sync(store, 100, ['wiki-editors']), SyncBusyError);
  assert.deepStrictEqual(store.edges(), []);
});

test('an expired lease is taken over', async () => {
  const store = new MemoryStore([
    { pk: `USER#${USER}`, sk: 'IDP_SYNC', type: 'IDP_SYNC', syncedAuthTime: 50, version: 3, leaseUntil: NOW_MS - 1 },
  ]);
  const result = await sync(store, 100, ['wiki-editors']);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(store.record()?.syncedAuthTime, 100);
  assert.strictEqual(store.record()?.version, 5);
});

test('losing the race for the lease starts over and sees the winner', async () => {
  const store = new MemoryStore([]);
  // Another synchroniser applies a newer sign-in between this one's read and
  // its write.
  store.beforeRecordWrite = () => {
    store.items.set(`USER#${USER}|IDP_SYNC`, {
      pk: `USER#${USER}`,
      sk: 'IDP_SYNC',
      type: 'IDP_SYNC',
      syncedAuthTime: 300,
      version: 0,
    });
  };
  const result = await sync(store, 100, ['wiki-editors']);
  assert.strictEqual(result.applied, false);
  assert.deepStrictEqual(store.edges(), []);
});

test('a holder that lost its lease does not write a grant', async () => {
  const store = new MemoryStore([]);
  await assert.rejects(
    syncIdpGroups(
      {
        userId: USER,
        authTime: 100,
        load: async () => {
          // Taken over while this run was reading the groups.
          const record = store.record()!;
          store.items.set(`USER#${USER}|IDP_SYNC`, { ...record, version: (record.version ?? 0) + 7 });
          return { provider: 'sso', groups: ['wiki-editors'] };
        },
      },
      store,
    ),
    SyncBusyError,
  );
  assert.deepStrictEqual(store.edges(), []);
});

test('a run that fails hands the lease back without advancing the time', async () => {
  const store = new MemoryStore([]);
  await assert.rejects(
    syncIdpGroups(
      {
        userId: USER,
        authTime: 100,
        load: async () => {
          throw new Error('pool unreachable');
        },
      },
      store,
    ),
    /pool unreachable/,
  );
  assert.strictEqual(store.record()?.syncedAuthTime, 0);
  assert.strictEqual(store.record()?.leaseUntil, undefined);
  // So the next request goes straight ahead.
  const next = await sync(store, 100, ['wiki-editors']);
  assert.strictEqual(next.applied, true);
});

test('a holder thawed past its budget writes nothing and does not advance the time', async () => {
  // A request is answered after 28 seconds while its handler is frozen, not
  // stopped; it may resume long after its lease expired.
  const store = new MemoryStore([edge('editors')]);
  await assert.rejects(
    syncIdpGroups(
      {
        userId: USER,
        authTime: 100,
        load: async () => {
          store.clock += 5 * 60 * 1000;
          return { provider: 'sso', groups: [] };
        },
      },
      store,
    ),
    SyncBusyError,
  );
  assert.deepStrictEqual(store.edges(), ['RG#editors'], 'no removal from a stale holder');
  assert.strictEqual(store.record()?.syncedAuthTime, 0);
});

test('the record lists the edges written, and an edge the partition read missed is still removed', async () => {
  const store = new MemoryStore([membership('ug_users')]);
  await sync(store, 100, ['wiki-editors']);
  assert.deepStrictEqual(store.record()?.roleGroupIds, ['editors']);

  // The partition read is eventually consistent: it may not show the edge the
  // previous synchronisation wrote a moment ago.
  const lagging = Object.assign(Object.create(store) as MemoryStore, {
    readOwn: async (userId: string) =>
      (await store.readOwn(userId)).filter((item) => item.type !== 'ROLE_MEMBERSHIP'),
  });
  await syncIdpGroups(
    { userId: USER, authTime: 200, load: async () => ({ provider: 'sso', groups: [] }) },
    lagging,
  );
  assert.deepStrictEqual(store.edges(), []);
  assert.deepStrictEqual(store.record()?.roleGroupIds, []);
});

test('the browser door writes the directory record, the bearer door does not', async () => {
  const store = new MemoryStore([]);
  await syncIdpGroups(
    { userId: USER, authTime: 100, load: async () => ({ provider: 'sso', groups: ['wiki-editors'] }), profileEmail: 'a@example.com' },
    store,
  );
  assert.strictEqual(store.profileWrites, 1);
  await sync(store, 200, ['wiki-editors']);
  assert.strictEqual(store.profileWrites, 1);
});

test('auth_time is read from the claims, or taken as now when absent', () => {
  assert.strictEqual(authTimeOf({ auth_time: 1234 }, NOW_MS), 1234);
  assert.strictEqual(authTimeOf({}, NOW_MS), NOW_S);
  assert.strictEqual(authTimeOf({ auth_time: 'soon' }, NOW_MS), NOW_S);
  // Two sign-ins without a time, a moment apart, stay distinct.
  assert.ok(authTimeOf({}, NOW_MS + 26) > authTimeOf({}, NOW_MS));
});

// ─── federatedGate ───────────────────────────────────────────────────────────

const poolUser = (overrides: Partial<PoolUser> = {}): PoolUser => ({
  sub: USER,
  enabled: true,
  groups: '["wiki-editors"]',
  identities: '[{"providerName":"Corp","userId":"x"}]',
  ...overrides,
});

function gateDeps(store: MemoryStore, user: PoolUser | Error = poolUser()) {
  const calls = { pool: 0 };
  const deps: GateDeps = {
    readPoolUser: async () => {
      calls.pool += 1;
      if (user instanceof Error) throw user;
      return user;
    },
    providerFor: (registration) => (registration === 'Corp' ? 'sso' : undefined),
    sync: (input) => syncIdpGroups(input, store),
    nowMs: () => NOW_MS,
  };
  return { deps, calls };
}

const gate = async (
  store: MemoryStore,
  deps: GateDeps,
  options: { authTime?: number | undefined; profile?: Item } = {},
) =>
  federatedGate(
    {
      own: await store.readOwn(USER),
      profile: options.profile ?? profile,
      token: { sub: USER, authTime: 'authTime' in options ? options.authTime : NOW_S - 60, username: 'Corp_x' },
      metadataUrl: 'https://wiki.example/.well-known/oauth-protected-resource/mcp',
    },
    deps,
  );

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'passed';
  } catch (error: unknown) {
    if (error instanceof Refusal) return error.status;
    if (error instanceof NoAccessError) return 'no-access';
    throw error;
  }
};

test('a password account passes without the pool being asked', async () => {
  const store = new MemoryStore([membership('ug_users')]);
  const { deps, calls } = gateDeps(store);
  const { identityProvider: _, ...password } = profile;
  assert.strictEqual(await gate(store, deps, { profile: password, authTime: 1 }), undefined);
  assert.strictEqual(calls.pool, 0, 'and an old sign-in is fine for a password account');
});

test('a newer sign-in is synchronised from the pool, once', async () => {
  const store = new MemoryStore([]);
  const { deps, calls } = gateDeps(store);
  const own = await gate(store, deps);
  assert.deepStrictEqual(store.edges(), ['RG#editors']);
  assert.ok(own?.some((item) => item.sk === 'RG#editors'), 'the new edges are handed to the walk');
  assert.strictEqual(await gate(store, deps), undefined);
  assert.strictEqual(calls.pool, 1);
});

test('a federated sign-in older than the limit is sent back to sign in', async () => {
  const store = new MemoryStore([edge('editors')]);
  const { deps } = gateDeps(store);
  const old = NOW_S - FEDERATED_SIGN_IN_MAX_AGE_SECONDS - 1;
  assert.strictEqual(await statusOf(gate(store, deps, { authTime: old })), 401);
  assert.strictEqual(await statusOf(gate(store, deps, { authTime: undefined })), 401);
});

test('a federated account with no permission is refused on every request', async () => {
  const store = new MemoryStore([
    { pk: `USER#${USER}`, sk: 'IDP_SYNC', type: 'IDP_SYNC', syncedAuthTime: NOW_S, version: 0 },
  ]);
  const { deps, calls } = gateDeps(store);
  assert.strictEqual(await statusOf(gate(store, deps, { authTime: NOW_S - 60 })), 'no-access');
  assert.strictEqual(calls.pool, 0, 'without asking the pool again');
});

test('a pool that cannot be read refuses rather than passing on old edges', async () => {
  const store = new MemoryStore([edge('editors')]);
  const { deps } = gateDeps(store, new Error('throttled'));
  assert.strictEqual(await statusOf(gate(store, deps)), 503);
  assert.strictEqual(store.record()?.syncedAuthTime, 0);
});

test('a pool user that is not the token\'s, or not from the same IdP, is refused', async () => {
  for (const user of [
    poolUser({ sub: 'someone-else' }),
    poolUser({ identities: '[{"providerName":"Other"}]' }),
    poolUser({ identities: undefined }),
  ]) {
    const store = new MemoryStore([edge('editors')]);
    const { deps } = gateDeps(store, user);
    assert.strictEqual(await statusOf(gate(store, deps)), 503);
    assert.deepStrictEqual(store.edges(), ['RG#editors'], 'nothing is rewritten on doubt');
  }
});

test('a user gone from the pool is sent back to sign in, not told to retry', async () => {
  const store = new MemoryStore([edge('editors')]);
  const gone = Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
  const { deps } = gateDeps(store, gone);
  assert.strictEqual(await statusOf(gate(store, deps)), 401);
});

test('a disabled pool user is refused', async () => {
  const store = new MemoryStore([edge('editors')]);
  const { deps } = gateDeps(store, poolUser({ enabled: false }));
  assert.strictEqual(await statusOf(gate(store, deps)), 401);
});

test('a group removed at the IdP is gone on the next sign-in through the bearer door', async () => {
  const store = new MemoryStore([
    edge('editors'),
    { pk: `USER#${USER}`, sk: 'IDP_SYNC', type: 'IDP_SYNC', syncedAuthTime: NOW_S - 3600, version: 0 },
  ]);
  const { deps } = gateDeps(store, poolUser({ groups: '[]' }));
  assert.strictEqual(await statusOf(gate(store, deps)), 'no-access');
  assert.deepStrictEqual(store.edges(), []);
});

test('the identities attribute is read for its provider names', () => {
  assert.deepStrictEqual(registrationsOf('[{"providerName":"A"},{"providerName":"B"}]'), ['A', 'B']);
  assert.deepStrictEqual(registrationsOf('not json'), []);
  assert.deepStrictEqual(registrationsOf(undefined), []);
});

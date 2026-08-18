/**
 * The two pure steps between an identity provider's claims and this Wiki's
 * permissions.
 *
 * Everything else about federated sign-in needs a server, and the e2e suite
 * drives it. These two do not, and they are where the interesting cases live:
 * the shapes an IdP may emit for a group claim, and the rule that a claim can
 * never reach the global administrator role group.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  canonicalUserIdFor,
  groupsFromClaims,
  hasEffectivePermission,
  roleGroupsForIdpGroups,
} from '../../aws-blocks/federation.js';
import type { Item } from '../../aws-blocks/model.js';

const roleGroup = (id: string, idpGroup?: string, global?: boolean): Item => ({
  pk: `RG#${id}`,
  sk: 'META',
  type: 'ROLE_GROUP',
  name: id,
  ...(idpGroup === undefined ? {} : { idpGroups: [{ provider: 'sso', group: idpGroup }] }),
  ...(global === undefined ? {} : { global }),
});

const roleGroupScoped = (
  id: string,
  idpGroups: { provider: string; group: string }[],
  global?: boolean,
): Item => ({
  pk: `RG#${id}`,
  sk: 'META',
  type: 'ROLE_GROUP',
  name: id,
  idpGroups,
  ...(global === undefined ? {} : { global }),
});

test('a list claim yields its string entries', () => {
  const groups = groupsFromClaims({ groups: ['editors', 'readers'] }, 'groups');
  assert.deepStrictEqual(groups, ['editors', 'readers']);
});

test('a single-string claim is one group, not a set of characters', () => {
  // A user in exactly one group is where several providers stop sending a list.
  assert.deepStrictEqual(groupsFromClaims({ groups: 'editors' }, 'groups'), ['editors']);
});

test('a JSON-stringified list is unpacked', () => {
  // The shape Cognito writes into a custom attribute when the IdP's claim is a
  // list — what a deployed stack reads out of the pool's ID token.
  const claims = { 'custom:groups': '["editors","readers"]' };
  assert.deepStrictEqual(groupsFromClaims(claims, 'custom:groups'), ['editors', 'readers']);
});

test("Cognito's non-JSON bracketed join is unpacked too", () => {
  // The other serialisation Cognito is known to produce: brackets and a
  // comma-space join, no quotes.
  const claims = { 'custom:groups': '[editors, readers]' };
  assert.deepStrictEqual(groupsFromClaims(claims, 'custom:groups'), ['editors', 'readers']);
});

test("percent-encoded values in Cognito's join are decoded", () => {
  // Cognito URL-encodes non-ASCII characters when it flattens the IdP's list
  // into the custom attribute — a OneLogin role named 営業部 arrives as
  // %E5%96%B6%E6%A5%AD%E9%83%A8 (observed against a real tenant, 2026-08-17).
  // ASCII identifiers pass through unchanged, and a stray "%" that is not
  // valid encoding is kept.
  const claims = { 'custom:groups': '[groupA, %E5%96%B6%E6%A5%AD%E9%83%A8, 100%hardcore]' };
  assert.deepStrictEqual(groupsFromClaims(claims, 'custom:groups'), [
    'groupA',
    '営業部',
    '100%hardcore',
  ]);
});

test('a stringified empty list grants nothing', () => {
  assert.deepStrictEqual(groupsFromClaims({ 'custom:groups': '[]' }, 'custom:groups'), []);
  assert.deepStrictEqual(groupsFromClaims({ 'custom:groups': '' }, 'custom:groups'), []);
});

test('non-string entries inside a JSON-stringified list are dropped', () => {
  const claims = { 'custom:groups': '["editors", 7, null]' };
  assert.deepStrictEqual(groupsFromClaims(claims, 'custom:groups'), ['editors']);
});

test('a bare string with a comma stays one group', () => {
  // Splitting is earned by the brackets, which only a packed list carries. A
  // group actually named with a comma must not be halved by the parser.
  assert.deepStrictEqual(groupsFromClaims({ groups: 'a,b' }, 'groups'), ['a,b']);
});

test('a repeated group is counted once', () => {
  assert.deepStrictEqual(groupsFromClaims({ groups: ['a', 'a', 'b'] }, 'groups'), ['a', 'b']);
});

test('non-string entries are dropped rather than coerced', () => {
  // Coercing would turn a numeric group id into the string that names a group,
  // which is a permission decided by a type conversion.
  assert.deepStrictEqual(groupsFromClaims({ groups: ['a', 7, null, { b: 1 }] }, 'groups'), ['a']);
});

test('a claim that is absent, or not a list or a string, grants nothing', () => {
  // Failing this way round makes a mistyped claim name a lockout rather than a
  // promotion.
  assert.deepStrictEqual(groupsFromClaims({}, 'groups'), []);
  assert.deepStrictEqual(groupsFromClaims({ groups: 42 }, 'groups'), []);
  assert.deepStrictEqual(groupsFromClaims({ groups: { a: 1 } }, 'groups'), []);
});

test('the claim consulted is the configured one', () => {
  const claims = { groups: ['wrong'], wiki_roles: ['right'] };
  assert.deepStrictEqual(groupsFromClaims(claims, 'wiki_roles'), ['right']);
});

test('a role group is reached by the IdP group it names', () => {
  const groups = [roleGroup('rg1', 'editors'), roleGroup('rg2', 'readers')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['editors']), ['rg1']);
});

test('matching folds case and surrounding whitespace', () => {
  // An administrator who typed `Wiki-Editors ` against a claim of
  // `wiki-editors` has made no mistake worth refusing.
  const groups = [roleGroup('rg1', ' Wiki-Editors ')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['wiki-editors']), ['rg1']);
});

test('a role group with no mapping is never reached', () => {
  const groups = [roleGroup('rg1'), roleGroup('rg2', 'editors')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['editors', '']), ['rg2']);
});

test('a blank mapping is unreachable even by a blank claim', () => {
  // The write path stores a blank mapping as "unmapped", but a blank that
  // arrived another way — a migration, a direct write — must not be reachable
  // by a claim list that happens to carry an empty or whitespace-only string.
  const groups = [roleGroup('rg1', ''), roleGroup('rg2', '  ')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['', '  ']), []);
});

test('the global administrator role group is unreachable however it is mapped', () => {
  // The write path refuses to set this mapping, but the refusal that holds the
  // line is this one: a value that arrived any other way must not confer
  // administrator of every space through a group membership in a system this
  // Wiki does not control.
  const groups = [roleGroup('rg_global_admin', 'everyone', true), roleGroup('rg1', 'everyone')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['everyone']), ['rg1']);
});

test('claiming no groups reaches no role group', () => {
  const groups = [roleGroup('rg1', 'editors')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', []), []);
});

test('a provider-scoped mapping is reached only through its own provider', () => {
  // OneLogin sends human-chosen group names, so `editors` may exist at two
  // IdPs at once — the entry names which one it trusts, and the other one's
  // claim must not ride on it.
  const groups = [roleGroupScoped('rg1', [{ provider: 'onelogin', group: 'editors' }])];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'onelogin', ['editors']), ['rg1']);
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['editors']), []);
});

test('two providers reach one role group through two entries', () => {
  const groups = [
    roleGroupScoped('rg1', [
      { provider: 'sso', group: 'guid-1234' },
      { provider: 'onelogin', group: 'editors' },
    ]),
  ];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['guid-1234']), ['rg1']);
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'onelogin', ['editors']), ['rg1']);
});

test('a mapping is never reached through a provider it does not name', () => {
  // The pre-multi-IdP provider-less field used to match any provider; that
  // path is gone, so an entry only answers to the provider it names.
  const groups = [roleGroup('rg1', 'editors')];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'onelogin', ['editors']), []);
});

test('the global administrator role group is unreachable through scoped entries too', () => {
  const groups = [
    roleGroupScoped('rg_global_admin', [{ provider: 'sso', group: 'everyone' }], true),
  ];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['everyone']), []);
});

test('a blank group inside a scoped entry is unreachable', () => {
  // The write path refuses blanks, but one that arrived another way must not
  // become reachable by a claim list carrying an empty string.
  const groups = [roleGroupScoped('rg1', [{ provider: 'sso', group: '  ' }])];
  assert.deepStrictEqual(roleGroupsForIdpGroups(groups, 'sso', ['', '  ']), []);
});

// ─── The zero-permission gate on federated sign-in ───────────────────────────
// A federated sign-in whose synchronisation ends with no permissions at all is
// refused. What counts is the post-sync state: the role groups the claims just
// reached, and the user-group memberships the Wiki itself holds.

const ownItem = (type: Item['type'], sk: string): Item => ({
  pk: 'USER#u1',
  sk,
  type,
  ...(type === 'USER' ? { email: 'u1@example.test' } : {}),
});

test('a role group reached by the claims is a permission', () => {
  assert.strictEqual(hasEffectivePermission([], new Set(['rg1'])), true);
});

test('a user-group membership is a permission even when the claims reach nothing', () => {
  // The seeded global administrator and a hand-granted user-group member have
  // no trace on the IdP side; the gate must not lock them out.
  const own = [ownItem('USER', 'PROFILE'), ownItem('MEMBERSHIP', 'UG#ug_admins')];
  assert.strictEqual(hasEffectivePermission(own, new Set()), true);
});

test('no role group and no user group is no permission', () => {
  assert.strictEqual(hasEffectivePermission([ownItem('USER', 'PROFILE')], new Set()), false);
  assert.strictEqual(hasEffectivePermission([], new Set()), false);
});

test('a stale direct role-group edge does not count', () => {
  // The synchronisation has already deleted every edge the claims no longer
  // name, so an edge still present in the pre-sync read must not hold the door
  // open for a user the IdP just revoked.
  const own = [ownItem('USER', 'PROFILE'), ownItem('ROLE_MEMBERSHIP', 'RG#rg1')];
  assert.strictEqual(hasEffectivePermission(own, new Set()), false);
});

const POOL_ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_EXAMPLE';

test("the pool issuer's prefix is stripped down to the bare sub", () => {
  // The block names an OIDC user `${iss}:${sub}`; everything else in the Wiki
  // names the same person by the pool `sub` alone.
  // Letters mixed in on purpose: a run of 12 straight digits would trip the
  // pre-commit scan that looks for real AWS account ids in public files.
  const sub = '2f6a1c0e-3d5b-4a7f-9e88-0c1d2e3f4a5b';
  assert.strictEqual(canonicalUserIdFor(POOL_ISSUER, `${POOL_ISSUER}:${sub}`), sub);
});

test('another issuer’s prefix passes through unchanged', () => {
  // An unexpected identifier stays visible as itself instead of being folded
  // into a sub it never was.
  const foreign = 'https://login.example.com:abc';
  assert.strictEqual(canonicalUserIdFor(POOL_ISSUER, foreign), foreign);
});

test('with no issuer configured nothing is stripped', () => {
  // Local development with the stub IdP: `SSO_ISSUER_URL` is empty, and the
  // stub’s `${iss}:${sub}` ids are kept whole.
  const stubId = 'https://stub.local:stub-sso-user';
  assert.strictEqual(canonicalUserIdFor('', stubId), stubId);
});

test('items that are not role groups are ignored', () => {
  const notARoleGroup: Item = {
    pk: 'RG#rg1',
    sk: 'SPACE#s1',
    type: 'GRANT',
    permission: 'admin',
    idpGroups: [{ provider: 'sso', group: 'editors' }],
  };
  assert.deepStrictEqual(roleGroupsForIdpGroups([notARoleGroup], 'sso', ['editors']), []);
});

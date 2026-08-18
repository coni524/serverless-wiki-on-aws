/**
 * Parsing of `sso.config.json` — the one place synth, the deploy script and
 * the runtime agree on what a deployment's external IdPs are.
 *
 * `parseSsoConfig` is pure, so every rule is exercised on plain objects with
 * no file on disk. The interesting cases are the compatibility rules: the
 * first entry keeps the historical names of the single-IdP days, names are
 * identity, and the runtime list round-trips through `SSO_PROVIDERS`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  parseSsoConfig,
  runtimeSsoProviders,
  ssoLogicalSuffix,
  ssoProvidersJson,
  ssoSecretName,
  ssoSettingIds,
} from '../../aws-blocks/sso-config.js';

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('SSO_')) delete process.env[name];
  }
});

const entra = {
  name: 'sso',
  issuerUrl: 'https://login.example.test/tenant/v2.0/',
  clientId: 'client-one',
};
const onelogin = {
  name: 'onelogin',
  issuerUrl: 'https://sub.onelogin.test/oidc/2',
  clientId: 'client-two',
  scopes: ['openid', 'email', 'profile', 'groups'],
};

test('an empty idps list means no entries', () => {
  assert.deepStrictEqual(parseSsoConfig({ idps: [] }).entries, []);
});

test('the first entry is primary, with the historical defaults', () => {
  const [entry, ...rest] = parseSsoConfig({ idps: [entra] }).entries;
  assert.deepStrictEqual(rest, []);
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.primary, true);
  assert.strictEqual(entry.registrationName, 'sso');
  assert.strictEqual(entry.providerName, 'sso');
  assert.strictEqual(entry.label, 'sso');
  // The trailing slash is dropped, as the issuer comparison downstream expects.
  assert.strictEqual(entry.issuerUrl, 'https://login.example.test/tenant/v2.0');
  assert.strictEqual(entry.groupsClaim, 'groups');
  assert.deepStrictEqual(entry.scopes, ['openid', 'email', 'profile']);
});

test('a registrationName may differ from the runtime name', () => {
  // The shape a pre-file deployment could reach with `SSO_IDP_NAME`: the
  // Cognito registration renamed while the runtime name — which keys sign-in
  // paths and every provider-scoped role-group mapping — stays put.
  const [entry] = parseSsoConfig({ idps: [{ ...entra, registrationName: 'entra' }] }).entries;
  assert.strictEqual(entry!.registrationName, 'entra');
  assert.strictEqual(entry!.providerName, 'sso');
});

test('later entries are not primary and keep their order', () => {
  const { entries } = parseSsoConfig({ idps: [entra, onelogin] });
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[1]!.primary, false);
  assert.strictEqual(entries[1]!.registrationName, 'onelogin');
  assert.deepStrictEqual(entries[1]!.scopes, ['openid', 'email', 'profile', 'groups']);
});

test('an entry without a clientId is refused', () => {
  assert.throws(() => parseSsoConfig({ idps: [{ name: 'sso', issuerUrl: 'https://x.test' }] }));
});

test('duplicate names are refused, whatever their case', () => {
  assert.throws(
    () => parseSsoConfig({ idps: [{ ...entra, name: 'entra' }, { ...onelogin, name: 'Entra' }] }),
    /share the name/,
  );
});

test('the reserved name COGNITO is refused', () => {
  assert.throws(() => parseSsoConfig({ idps: [{ ...entra, name: 'COGNITO' }] }), /cannot name/);
});

test('the reserved name true is refused', () => {
  // `SSO_REMOVE=true` means "remove everything", so a provider named `true`
  // could never be removed individually.
  assert.throws(() => parseSsoConfig({ idps: [{ ...entra, name: 'true' }] }), /cannot name/);
});

test('names that differ only in punctuation are refused as one logical id', () => {
  assert.throws(
    () =>
      parseSsoConfig({
        idps: [entra, { ...onelogin, name: 'one.login' }, { ...onelogin, name: 'one-login' }],
      }),
    /logical-id suffix/,
  );
});

test('more entries than the supported maximum are refused', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...entra, name: `idp${i}` }));
  assert.throws(() => parseSsoConfig({ idps: many }));
});

test('the primary entry keeps the historical secret, setting and output names', () => {
  const [primary, second] = parseSsoConfig({ idps: [entra, onelogin] }).entries;
  assert.strictEqual(ssoSecretName(primary!, 'stack'), 'stack-sl-wiki-sso-idp-client-secret');
  assert.strictEqual(
    ssoSecretName(second!, 'stack'),
    'stack-sl-wiki-sso-idp-onelogin-client-secret',
  );
  assert.deepStrictEqual(ssoSettingIds({ name: 'sso', primary: true }), {
    clientId: 'sso-client-id',
    clientSecret: 'sso-client-secret',
  });
  assert.deepStrictEqual(ssoSettingIds({ name: 'onelogin', primary: false }), {
    clientId: 'sso-client-id-onelogin',
    clientSecret: 'sso-client-secret-onelogin',
  });
  assert.strictEqual(ssoLogicalSuffix(primary!), '');
  assert.strictEqual(ssoLogicalSuffix(second!), 'Onelogin');
});

test('an explicit secret name wins over the derived one', () => {
  const { entries } = parseSsoConfig({ idps: [{ ...entra, secretName: 'my-own-secret' }] });
  assert.strictEqual(ssoSecretName(entries[0]!, 'stack'), 'my-own-secret');
});

test('callback origins are read with trailing slashes dropped', () => {
  const config = parseSsoConfig({ idps: [entra], callbackOrigins: ['https://wiki.example.test/'] });
  assert.deepStrictEqual(config.callbackOrigins, ['https://wiki.example.test']);
});

test('sandbox participation defaults to on and can be switched off', () => {
  assert.strictEqual(parseSsoConfig({ idps: [entra] }).sandbox, true);
  assert.strictEqual(parseSsoConfig({ idps: [entra], sandbox: false }).sandbox, false);
});

test('the runtime list round-trips through SSO_PROVIDERS', () => {
  const { entries } = parseSsoConfig({ idps: [{ ...entra, label: 'Contoso' }, onelogin] });
  process.env.SSO_PROVIDERS = ssoProvidersJson(entries);
  assert.deepStrictEqual(runtimeSsoProviders(), [
    { name: 'sso', label: 'Contoso', primary: true },
    { name: 'onelogin', label: 'onelogin', primary: false },
  ]);
});

test('with no SSO_PROVIDERS but a configured issuer, the single-IdP shape returns', () => {
  // A Lambda deployed before the variable existed — the fallback reproduces
  // what those environments were built for.
  process.env.SSO_ISSUER_URL = 'https://pool.example.test';
  assert.deepStrictEqual(runtimeSsoProviders(), [{ name: 'sso', label: 'sso', primary: true }]);
});

test('with nothing configured the runtime list is empty', () => {
  assert.deepStrictEqual(runtimeSsoProviders(), []);
});

test('a hand-mangled SSO_PROVIDERS is refused rather than part-read', () => {
  process.env.SSO_PROVIDERS = '[{"name":"sso"}]';
  assert.throws(() => runtimeSsoProviders(), /not the list synth writes/);
});

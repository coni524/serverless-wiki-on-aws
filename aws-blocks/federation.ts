/**
 * Sign-in through an external identity provider.
 *
 * The Wiki answers to two kinds of account, and both live in the same Cognito
 * user pool. One holds a password in the pool and is served by `AuthCognito`
 * in `resources.ts`. The other is issued by a company's own IdP — OneLogin,
 * Okta, Entra — which `index.cdk.ts` registers on that same pool as an OIDC
 * identity provider. The `AuthOIDC` block here does not talk to that IdP: it
 * points at the pool's own issuer URL, whose hosted sign-in domain forwards to
 * the IdP and creates the federated account in the pool on the way back. What
 * this block receives is a Cognito-issued ID token, whichever IdP stood behind
 * it.
 *
 * Both kinds land in the same permission model under the same identifier — the
 * pool's `sub`. `access.ts` reads whichever session exists and hands the
 * resolved identifier to the same three-hop walk, so nothing downstream of it
 * knows which door a request came through.
 *
 * ─── Why the Building Block lives here and not in `resources.ts` ─────────────
 * Its `onSignIn` hook is the claim-to-role-group synchronisation below, which
 * needs the permission table. `resources.ts` is what *provides* that table, so
 * configuring the block there would be a cycle. The Agent block in
 * `assistant.ts` sits outside `resources.ts` for the same reason: a block whose
 * configuration is application logic lives with that logic.
 *
 * ─── What decides permissions, and what does not ────────────────────────────
 * The IdP's group claim is never read at authorization time. It is read once,
 * at sign-in, and written into `ROLE_MEMBERSHIP` edges in DynamoDB. Everything
 * that decides what a request may do reads those edges. That keeps the single
 * authorization path this project is built on — a claim cannot become a second
 * way to be permitted.
 */
import { AppSetting, AuthOIDC, customOidc, stubIdp } from '@aws-blocks/blocks';
import type { OIDCUser } from '@aws-blocks/blocks';
import { ApiError } from '@aws-blocks/core';

import { runtimeSsoProviders, ssoSettingIds } from './sso-config.js';
import { scope, table } from './resources.js';
import { bumpEpoch } from './epoch.js';
import {
  ALL_ROLE_GROUPS,
  ALL_USERS,
  PROFILE,
  type Item,
  idOf,
  roleGroupPk,
  sortable,
  userPk,
} from './model.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * The OIDC issuer the block signs in against — the Wiki's own user pool.
 *
 * Not the external IdP's issuer: the pool sits between, and its discovery
 * document names the hosted sign-in domain that forwards to the IdP. The
 * deploy scripts derive this from the running stack's pool id, so an operator
 * never types it.
 *
 * Deploy-time rather than a stored setting, because the block needs a concrete
 * string when the provider is constructed — which happens during synth, before
 * any stored value could be read. Leaving it unset is how a deployment says it
 * has no external IdP: no provider is declared, no routes are created, and the
 * sign-in screen offers only the password form.
 *
 * Trailing slashes are dropped so the value compares equal to the `iss` claim
 * Cognito writes into its tokens, which `canonicalUserId` below relies on.
 */
const ISSUER_URL = (process.env.SSO_ISSUER_URL ?? '').trim().replace(/\/+$/, '');

/**
 * Which ID-token claim carries the signing-in user's groups.
 *
 * On a deployed stack the token is Cognito's, and the IdP's group claim
 * arrives copied into the pool's `custom:groups` attribute by the identity
 * provider registration in `index.cdk.ts` — the deploy scripts set this to
 * `custom:groups` accordingly. The default stays `groups` for the local stub,
 * which issues its claims directly with no pool in between. It sits in the
 * environment beside the issuer URL because both describe the *shape* of what
 * is being talked to; the credentials are stored settings, and the mapping
 * from groups to permissions is the Wiki's own data. Three kinds of
 * configuration, three places, chosen by who owns the answer.
 */
const GROUPS_CLAIM = (process.env.SSO_GROUPS_CLAIM ?? '').trim() || 'groups';

/**
 * The scopes asked of the pool, when the block's defaults are not enough.
 *
 * The block's default `openid email profile` is exactly what the pool's
 * federation app client allows, so a deployment normally leaves this unset.
 * It remains configuration because the failure mode of a scope mismatch is
 * "sign-in works, nobody has permissions" with nothing pointing at the cause,
 * and an operator debugging that needs a knob that does not require a code
 * change.
 */
const SCOPES = (process.env.SSO_SCOPES ?? '')
  .split(/[\s,]+/)
  .map((scope) => scope.trim())
  .filter((scope) => scope !== '');

/** True inside Lambda, where the runtime always sets this. Never true locally. */
const IN_LAMBDA = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

/**
 * Whether to stand up the in-process stub IdP instead of talking to a real one.
 *
 * The stub approves sign-ins without authenticating anybody, so it is a way in
 * for whoever can reach it. Two independent conditions therefore have to hold,
 * and both of them fail closed: the dev server sets `SSO_STUB` and nothing else
 * does (`deploy.ts` and `sandbox.ts` clear it before synth), and the check
 * additionally refuses to run inside Lambda. Neither alone is trusted, because
 * an environment variable is ambient and a runtime check cannot reach synth.
 */
const USE_STUB = process.env.SSO_STUB === 'true' && !IN_LAMBDA;

/**
 * The credentials of the pool's federation app client.
 *
 * Not the external IdP's credentials — those are read by the identity provider
 * registration in `index.cdk.ts` and never reach the runtime. What this block
 * authenticates to is the pool's own token endpoint, as the confidential app
 * client the CDK creates for it; the deploy scripts read that client's id and
 * secret back from Cognito after each deploy and write them here, so no
 * operator ever handles them. Stored settings rather than deploy-time values
 * because the block resolves them on the first sign-in each execution
 * environment serves, which is what lets the deploy script fill them in after
 * the stack — including the client — already exists.
 */
export const ssoClientId = new AppSetting(scope, 'sso-client-id', { secret: true });
export const ssoClientSecret = new AppSetting(scope, 'sso-client-secret', { secret: true });

/**
 * The providers this deployment was synthesised with — names and labels,
 * carried in from the `sso.config.json` entries through `SSO_PROVIDERS`
 * (`sso-config.ts`). Empty on a deployment with no external IdP.
 */
const RUNTIME_PROVIDERS = runtimeSsoProviders();

/**
 * Each provider's federation-client credentials. The primary entry reads the
 * unconditional pair above (its ids predate multi-IdP support); every other
 * provider gets a pair of its own, named after it, which the deploy script
 * fills the same way.
 */
const credentialSettings = new Map(
  RUNTIME_PROVIDERS.map((provider) => {
    if (provider.primary) {
      return [provider.name, { clientId: ssoClientId, clientSecret: ssoClientSecret }] as const;
    }
    const ids = ssoSettingIds(provider);
    return [
      provider.name,
      {
        clientId: new AppSetting(scope, ids.clientId, { secret: true }),
        clientSecret: new AppSetting(scope, ids.clientSecret, { secret: true }),
      },
    ] as const;
  }),
);

/**
 * The configured providers, in the order the sign-in screen shows them.
 *
 * Every entry points at the same issuer — the pool — and differs in name and
 * credentials: each external IdP stands behind an app client of its own, so
 * the hosted UI forwards a sign-in straight to its IdP instead of drawing a
 * chooser.
 */
const providers =
  ISSUER_URL !== ''
    ? RUNTIME_PROVIDERS.map((provider) => {
        // A configured issuer is talked to in every environment, local
        // development included. Pointing a developer's machine at the real
        // pool is a matter of registering `http://localhost:3000/...` on the
        // pool's federation app clients, and getting that wrong should fail
        // loudly rather than be papered over by a stub that signs anybody in.
        const credentials = credentialSettings.get(provider.name)!;
        return customOidc({
          name: provider.name,
          issuerUrl: ISSUER_URL,
          clientId: () => credentials.clientId.get(),
          clientSecret: () => credentials.clientSecret.get(),
          ...(SCOPES.length > 0 ? { scopes: SCOPES } : {}),
        });
      })
    : USE_STUB
      ? [
          stubIdp({
            // The name becomes the sign-in path segment
            // (`/aws-blocks/auth/signin/sso`), matching what a real deployment
            // calls its primary provider.
            name: 'sso',
            // Sign in as the first local identity instead of drawing an account
            // picker. The picker is the block's default and is the more
            // realistic shape, but there is nobody to click it in the e2e
            // suite, and a federated sign-in that no test can drive is the part
            // of this feature most worth testing left untested. Which identity
            // that is, and what groups it claims, comes from
            // `.bb-data/<id>/users.json` — the suite writes one.
            onAuthorize: (request) => request.users[0],
          }),
        ]
      : [];

/**
 * Which providers this deployment can sign a user in with.
 *
 * The sign-in screen reads this through the API and draws one button per entry,
 * so turning federation on or off changes the screen without rebuilding the
 * frontend. Empty means the password form is the only way in. The label is the
 * operator's `SSO_IDP[_<n>]_LABEL`, or the name; the stub answers with its
 * name, which is all it has.
 */
export const federationProviders: ReadonlyArray<{ name: string; label: string }> =
  ISSUER_URL !== ''
    ? RUNTIME_PROVIDERS.map(({ name, label }) => ({ name, label }))
    : providers.map((provider) => ({ name: provider.name, label: provider.name }));

// ─── The block ───────────────────────────────────────────────────────────────

/**
 * The OIDC sign-in gate, or `null` on a deployment with no external IdP.
 *
 * Null rather than an instance with an empty provider list, because the block
 * refuses to be constructed without a provider — it throws `AuthOIDC requires
 * at least one provider`. This module is imported by `access.ts`, and
 * `access.ts` by every request path, so an instance built unconditionally would
 * take the whole backend down at synth on any deployment that never asked for
 * federation.
 *
 * Every caller therefore checks. There is exactly one (`access.ts`), and it was
 * already branching on whether federation is configured at all.
 */
export const oidcAuth =
  providers.length > 0
    ? new AuthOIDC(scope, 'sso', {
        providers,
        onSignIn: (user, _context) => syncRoleGroups(user),
        // Matches `AuthCognito` in `resources.ts`: in a sandbox the frontend is
        // served from localhost while the API answers from API Gateway, which
        // are different registrable domains, and a `SameSite=Lax` cookie would
        // not survive the round trip.
        crossDomain: process.env.BLOCKS_SANDBOX === 'true',
      })
    : null;

// ─── Identifier canonicalisation ─────────────────────────────────────────────

/**
 * The pool `sub` behind an OIDC session's user id.
 *
 * The block names a user `${iss}:${sub}` so that two IdPs cannot collide, but
 * this deployment has exactly one issuer — its own pool — and every other part
 * of the system (permission records, the directory, `bearer-auth.ts`, the
 * password door) already names that user by the bare `sub`. Stripping the
 * prefix here, at the door, is what keeps the identifier space single.
 *
 * Only the configured issuer's prefix is stripped. Any other prefix — the
 * local stub's, or a session written under the withdrawn `${iss}:${sub}`
 * scheme — passes through unchanged, so an unexpected identifier stays visible
 * as itself instead of being folded into a `sub` it never was.
 */
export function canonicalUserId(userId: string): string {
  return canonicalUserIdFor(ISSUER_URL, userId);
}

/** The rule itself, with the issuer as an argument so tests can reach it. */
export function canonicalUserIdFor(issuerUrl: string, userId: string): string {
  if (issuerUrl !== '' && userId.startsWith(`${issuerUrl}:`)) {
    return userId.slice(issuerUrl.length + 1);
  }
  return userId;
}

// ─── Claims to role groups ───────────────────────────────────────────────────

/**
 * The IdP groups named by one sign-in's claims.
 *
 * The claim arrives in more shapes than one. An IdP that is talked to directly
 * — the local stub — emits a list, or a single string for a user in exactly
 * one group. A deployed stack reads the claim from a Cognito ID token instead,
 * where the pool has flattened the IdP's list into the string value of a
 * custom attribute: JSON (`["a","b"]`) or Cognito's own bracketed join
 * (`[a, b]`). All of those are accepted; a bracketed string is unpacked, a
 * bare string is one group. Anything else — a number, an object, absent —
 * reads as no groups, which grants nothing. Failing that way round is what
 * makes a misconfigured claim name a lockout rather than a promotion.
 */
export function groupsFromClaims(
  claims: Readonly<Record<string, unknown>>,
  claimName: string,
): string[] {
  const raw = claims[claimName];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? unpackClaimString(raw) : [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    ),
  ];
}

/**
 * The list a stringified group claim carries, or the string itself as one
 * group when it is not a packed list.
 *
 * JSON is tried first because it round-trips exactly. The bracketed fallback
 * exists for Cognito's non-JSON join, and splits on commas — safe for that
 * shape, because it only ever packs the IdP's group identifiers, and unsafe
 * shapes (a group name containing a comma) can only reach here as a real list
 * or a bare string, neither of which is split.
 *
 * Values are percent-decoded on the way out, because a packed string is by
 * definition Cognito's rendering of an attribute, and Cognito URL-encodes
 * non-ASCII characters in it — a OneLogin role named `営業部` arrives as
 * `%E5%96%B6%E6%A5%AD%E9%83%A8`, which no administrator would think to type
 * into a mapping.
 * ASCII identifiers (Entra's GUIDs) pass through decoding unchanged, and a
 * value that merely contains a stray `%` is kept as-is rather than dropped.
 */
function unpackClaimString(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [raw];
  let values: unknown[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    values = Array.isArray(parsed) ? parsed : [raw];
  } catch {
    values = trimmed.slice(1, -1).split(',');
  }
  return values.map((value) => (typeof value === 'string' ? percentDecode(value) : value));
}

/** The decoded value, or the value itself when it is not valid percent-encoding. */
function percentDecode(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * One role group's mapping entries: each names the provider whose group it
 * trusts. (The pre-multi-IdP single `idpGroup` field is no longer read — every
 * stored mapping was rewritten into this shape before that path was removed.)
 */
function idpMappingsOf(item: Item): { provider: string; group: string }[] {
  return Array.isArray(item.idpGroups) ? item.idpGroups : [];
}

/**
 * The role groups one sign-in's IdP group list reaches.
 *
 * The mapping is not a record of its own: each role group carries the entries
 * naming which provider's groups reach it, so listing the role groups *is*
 * reading the mapping. An entry only counts when its provider is the one the
 * user actually signed in through — OneLogin sends human-chosen group names,
 * so a name that happens to exist at two IdPs must not let one IdP hand out
 * the other's permissions. Group matching folds case and trims, because
 * directory group names are not case-sensitive in practice and an
 * administrator who typed `Wiki-Editors ` against a claim of `wiki-editors`
 * has made no mistake worth refusing.
 *
 * A `global: true` role group is never reachable this way, whatever its
 * entries say. `setRoleGroupIdpGroups` already refuses to write one, but the
 * refusal to *read* one is what actually holds the line: a value that arrived
 * some other way — a migration, a direct write to the table, an API added later
 * — would otherwise make "administrator of every space in the Wiki" something a
 * group membership in a system this Wiki does not control could confer. The
 * check belongs where the permission is granted, not only where it is
 * configured.
 */
export function roleGroupsForIdpGroups(
  roleGroups: Item[],
  provider: string,
  idpGroups: string[],
): string[] {
  const wanted = new Set(idpGroups.map(sortable));
  // The empty name never matches anything. `setRoleGroupIdpGroups` refuses to
  // store one, but a blank that arrived some other way — a migration, a direct
  // write — must not become reachable by a claim list that happens to carry an
  // empty string.
  wanted.delete('');
  return roleGroups
    .filter((item) => item.type === 'ROLE_GROUP' && item.global !== true)
    .filter((item) =>
      idpMappingsOf(item).some(
        (mapping) =>
          mapping.provider === provider &&
          sortable(mapping.group) !== '' &&
          wanted.has(sortable(mapping.group)),
      ),
    )
    .map((item) => idOf(item.pk));
}

/**
 * Whether a just-synchronised federated account holds any permission at all.
 *
 * `syncedRoleGroups` is the role-group set the sign-in's claims reach, so a
 * stale `ROLE_MEMBERSHIP` edge in `own` deliberately does not count — the
 * synchronisation deletes it before this is asked. `MEMBERSHIP` edges do
 * count: user groups belong to the Wiki, not the IdP, and they are the only
 * road to a federated account the IdP grants nothing — the seeded
 * administrator, and anyone an administrator placed in a user group by hand.
 * After synchronisation those two edge kinds are the only ways to any
 * permission, the global administrator included, so checking them *is*
 * checking the effective permissions.
 */
export function hasEffectivePermission(
  own: readonly Item[],
  syncedRoleGroups: ReadonlySet<string>,
): boolean {
  return syncedRoleGroups.size > 0 || own.some((item) => item.type === 'MEMBERSHIP');
}

/**
 * Make the user's direct role-group edges say exactly what the IdP just said.
 *
 * Additive synchronisation was rejected: it cannot express a removal, so a user
 * taken out of a group at the IdP would keep the permission here forever, and
 * the whole point of delegating to the IdP is that the IdP is where the answer
 * lives. Edges the claims no longer name are therefore deleted.
 *
 * Only `ROLE_MEMBERSHIP` is rewritten. User-group membership belongs to the
 * Wiki and is left alone — that is what lets `seed-admin` grant an
 * administrator who signs in through the IdP, and what keeps an IdP
 * misconfiguration from locking every administrator out at once.
 *
 * Throwing here fails the sign-in and sets no cookie, which is deliberate: a
 * session whose permissions could not be established should not exist.
 */
async function syncRoleGroups(user: OIDCUser): Promise<void> {
  const userId = canonicalUserId(user.userId);
  // The same fallback `access.ts` uses when it reads a federated session. Two
  // different ones would fight: an IdP that supplies no address would have this
  // write the empty string, the next request write the display name, and the
  // next sign-in write the empty string again — rewriting the directory's sort
  // key, and reordering the account list, on every round.
  const email = user.email ?? user.username;

  const [own, roleGroups] = await Promise.all([
    Array.fromAsync(table.query({ where: { pk: { equals: userPk(userId) } } })),
    Array.fromAsync(table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_ROLE_GROUPS } } })),
  ]);

  const wanted = new Set(
    roleGroupsForIdpGroups(roleGroups, user.provider, groupsFromClaims(user.claims, GROUPS_CLAIM)),
  );
  const held = new Set(
    own.filter((item) => item.type === 'ROLE_MEMBERSHIP').map((item) => idOf(item.sk)),
  );

  const toAdd = [...wanted].filter((id) => !held.has(id));
  const toRemove = [...held].filter((id) => !wanted.has(id));

  // Removals are completed and announced before anything else runs. The two
  // directions fail differently: an addition that lands while a later step
  // throws costs the user a permission they should have, until the backstop TTL
  // expires. A removal in the same position is a permission this Wiki has
  // revoked and every warm execution environment goes on handing out for the
  // same five minutes. Only one of those is worth ordering around, so the
  // revocation runs first and moves the generation immediately.
  if (toRemove.length > 0) {
    await Promise.all(
      toRemove.map((roleGroupId) =>
        table.delete({ pk: userPk(userId), sk: roleGroupPk(roleGroupId) }),
      ),
    );
    await bumpEpoch();
  }

  // A federated sign-in that ends with no permissions at all does not happen:
  // an account with nothing to see is turned away at the door rather than let
  // in to an empty screen. The check sits above the profile write so a rejected
  // visitor never appears in the user directory, and below the removals so a
  // revocation down to zero still lands before the refusal. The password door
  // has no such gate — its accounts are created by an operator on purpose, and
  // it is the way back in when the IdP configuration locks everyone out.
  if (!hasEffectivePermission(own, wanted)) {
    throw new ApiError(
      'This account has no access to this wiki yet. Ask a wiki administrator to grant access, then sign in again.',
      403,
      { name: 'ForbiddenException' },
    );
  }

  await writeProfile(own, userId, email, user.provider);

  if (toAdd.length > 0) {
    const at = new Date().toISOString();
    await Promise.all(
      toAdd.map((roleGroupId) =>
        table.put({
          pk: userPk(userId),
          sk: roleGroupPk(roleGroupId),
          type: 'ROLE_MEMBERSHIP',
          gsi1pk: roleGroupPk(roleGroupId),
          gsi1sk: userPk(userId),
          addedAt: at,
          addedBy: `idp:${user.provider}`,
        }),
      ),
    );
    await bumpEpoch();
  }

  // Nothing moved, so nothing is announced. Bumping on every sign-in would
  // throw away every execution environment's resolved answers for every user
  // each time anybody signed in, which is the cost this counter exists to
  // avoid.
}

/**
 * Record the account in the user directory, or refresh what is displayed of it.
 *
 * `access.ts` provisions a directory record on first sign-in too, but only from
 * what a session carries. Writing it here is what puts `identityProvider` on
 * it, which is how the management screens know not to offer edits the next
 * sign-in would undo.
 */
async function writeProfile(
  own: Item[],
  userId: string,
  email: string,
  // The door the sign-in actually came through, not a configured constant:
  // with more than one provider the record has to say which one owns this
  // account.
  provider: string,
): Promise<void> {
  const profile = own.find((item) => item.type === 'USER');

  if (profile === undefined) {
    await table.put({
      pk: userPk(userId),
      sk: PROFILE,
      type: 'USER',
      gsi1pk: ALL_USERS,
      gsi1sk: sortable(email),
      email,
      identityProvider: provider,
      createdAt: new Date().toISOString(),
      version: 0,
    });
    return;
  }

  if (profile.email === email && profile.identityProvider === provider) return;
  await table
    .put(
      {
        ...profile,
        email,
        gsi1sk: sortable(email),
        identityProvider: provider,
        version: (profile.version ?? 0) + 1,
      },
      { ifFieldEquals: { version: profile.version ?? 0 } },
    )
    // A concurrent sign-in in another tab writing the same values is the
    // expected loser here, and the display address is not worth a failed
    // sign-in.
    .catch(() => undefined);
}

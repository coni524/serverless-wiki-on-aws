/**
 * Bearer token authentication, for the surface reached without a browser.
 *
 * That surface is the MCP server at `/mcp`, which AI clients speak to. The code
 * that decides *who is calling* lives here rather than in `mcp.ts`: it answers
 * to the user pool, the two scopes, and the permission walk, and it carries the
 * federated-account gate below. None of that is about the MCP protocol itself.
 *
 * What a caller gets back is an `Access`: the resolved result of the three-hop
 * permission walk. It is not a licence to skip the space check —
 * every operation re-checks the space it touches — it is only the answer to
 * "whose permissions apply".
 *
 * ─── The two gates, and why both exist ──────────────────────────────────────
 * 1. The scope decides what a *token* may attempt. It is coarse: `slwiki/write`
 *    says the user agreed this client may write something, somewhere.
 * 2. The DynamoDB permission walk decides what its *user* may do, per space.
 *
 * A token carrying `slwiki/write` still gets a refusal on a space the user
 * cannot write. Neither gate substitutes for the other.
 */
import { ApiError, type BlocksContext } from '@aws-cdk-blocks/core';
import { getRequestBaseUrl } from '@aws-cdk-blocks/core/bb-utils';
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { type Access, accessForUser, requireAccess } from './access.js';
import { DEPLOYED } from './deployed.js';
import {
  NoAccessError,
  SyncBusyError,
  directRoleGroups,
  groupsFromClaims,
  hasEffectivePermission,
  providerForRegistration,
  syncIdpGroups,
} from './federation.js';
import type { Item } from './model.js';

// ─── Configuration ───────────────────────────────────────────────────────────
// Written into the Lambda's environment by `index.cdk.ts`, which is also what
// creates the sign-in domain, the public app client, and the resource server
// these three values describe. All three or none: a half-configured server
// would verify tokens it cannot tell clients how to obtain.

const USER_POOL_ID = process.env.MCP_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.MCP_CLIENT_ID ?? '';

/** The hosted sign-in domain, without its trailing slash. */
export const AUTH_DOMAIN = (process.env.MCP_AUTH_DOMAIN ?? '').replace(/\/+$/, '');

export const OAUTH_CONFIGURED = USER_POOL_ID !== '' && CLIENT_ID !== '' && AUTH_DOMAIN !== '';

/**
 * The URL this Wiki is reached at from outside, stated rather than inferred.
 *
 * Metadata that names an endpoint the client never connected to fails
 * discovery, because RFC 9728 has the client check exactly that. Behind the
 * CloudFront door `Hosting` creates, the framework reports the address the
 * client called in the request URL, so the request alone gets that case right.
 * It cannot know an address it was never told about — a domain put in front of
 * the distribution by something other than `Hosting` — and the distribution's
 * domain cannot be injected from CDK either: the distribution points at the
 * API, which points at this Lambda, so feeding it back into the Lambda's
 * environment is a CloudFormation cycle.
 *
 * So the operator can state it, and `pnpm run deploy` states the distribution's
 * own address on every deploy (`scripts/deploy.ts`):
 *
 *   MCP_PUBLIC_ORIGIN=https://wiki.example.com pnpm run deploy
 *
 * Left empty, the request is trusted, which is right where the client talks to
 * API Gateway directly (a sandbox) or to the dev server (locally).
 */
export const PUBLIC_ORIGIN = (process.env.MCP_PUBLIC_ORIGIN ?? '').replace(/\/+$/, '');

/** The two custom scopes on the `slwiki` resource server. */
export const SCOPE_READ = 'slwiki/read';
export const SCOPE_WRITE = 'slwiki/write';

/** The realm named in `WWW-Authenticate`. */
const REALM = 'sl-wiki';

/**
 * Verifies the signature, issuer, expiry, `token_use` and `client_id` of an
 * incoming access token. Constructing it costs nothing — the JWKS is fetched on
 * the first verification and cached for the life of the container.
 *
 * `null` means no OAuth configuration reached this process, which is the state
 * of local development. Being null is the single test for that everywhere
 * below, so the two can never disagree.
 */
const verifier = OAUTH_CONFIGURED
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'access',
      clientId: CLIENT_ID,
    })
  : null;

// ─── HTTP-level refusals ─────────────────────────────────────────────────────

/**
 * A refusal that has to carry its own status and headers.
 *
 * `ApiError` covers everything the Wiki's own layers refuse, and the MCP route
 * wrapper already turns one into the right status. This exists for the
 * OAuth-shaped refusals, which must also carry `WWW-Authenticate` — the header
 * a client reads to find out where to authenticate (RFC 9728).
 */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly extraHeaders: Record<string, string> = {},
  ) {
    super('Request refused');
    this.name = 'BearerRefusal';
  }
}

/**
 * The externally visible URL this deployment is reached at, with `suffix`
 * stripped off the end.
 *
 * `MCP_PUBLIC_ORIGIN` wins when it is set (see the constant). Otherwise the
 * request is the answer, in one of two shapes. The request URL's path is the
 * route path, with no API Gateway stage in it, so for a client that calls the
 * gateway directly the base comes from `getRequestBaseUrl()`, which is the
 * gateway's origin plus its stage. Behind the CloudFront door the request URL
 * is the address the client called — another host than the gateway's, and no
 * stage in the path — so that origin is the base. What is left in both cases
 * is to put back whatever sits in front of the route's own path.
 */
export function baseUrl(context: BlocksContext, suffix: string): string {
  if (PUBLIC_ORIGIN !== '') return PUBLIC_ORIGIN;
  const { origin, pathname } = context.request.url;
  const prefix = pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : '';
  const gateway = getRequestBaseUrl(context);
  const root = new URL(gateway).origin === origin ? gateway : origin;
  return root + prefix;
}

export function unauthorized(metadataUrl: string, description: string): Refusal {
  return new Refusal(
    401,
    { error: 'invalid_token', error_description: description },
    {
      'WWW-Authenticate':
        `Bearer realm="${REALM}", error="invalid_token", ` +
        `error_description="${description}", ` +
        `resource_metadata="${metadataUrl}"`,
    },
  );
}

/**
 * Refuse for want of a scope, in the shape a client can act on.
 *
 * Naming the missing scope in `WWW-Authenticate` is what lets a client go back
 * to the authorization server and ask for it, rather than reporting a dead end
 * to its user. That is why a missing write scope is an HTTP refusal and not a
 * result payload: a result is something to read, a 403 with this header is
 * something to recover from.
 */
export function insufficientScope(metadataUrl: string, missing: string): Refusal {
  return new Refusal(
    403,
    { error: 'insufficient_scope', error_description: `The access token lacks ${missing}` },
    {
      'WWW-Authenticate':
        `Bearer realm="${REALM}", error="insufficient_scope", ` +
        `scope="${missing}", ` +
        `resource_metadata="${metadataUrl}"`,
    },
  );
}

// ─── Authentication ──────────────────────────────────────────────────────────

/** Who is calling, and what their token was authorized to attempt. */
export type Caller = { access: Access; scopes: Set<string> };

/**
 * Resolve the caller from the bearer access token.
 *
 * The token's `sub` is the Cognito-assigned user identifier every permission
 * record points at, so it goes straight into `accessForUser`, and
 * from there the three-hop permission walk is the same one the UI-facing API
 * runs. `accessForUser` never provisions: an account that has signed in to
 * Cognito but never to the Wiki has no directory record and is refused here.
 *
 * `metadataUrl` is where clients are told to look for the RFC 9728 document;
 * it only ever ends up inside a refusal header.
 *
 * ─── The local-development path ─────────────────────────────────────────────
 * Without a user pool there is nothing to verify a token against, so local
 * development authenticates the same way the UI does — the session cookie, via
 * `requireAccess`. This is a real sign-in, not a bypass, and it is unreachable
 * on AWS twice over: `index.cdk.ts` always sets the three variables, and the
 * branch additionally refuses to run in any deployed compute. It exists so the
 * e2e suite can drive the MCP server, including the permission refusals, against
 * the local mock.
 */
export async function authenticate(
  context: BlocksContext,
  metadataUrl: string,
): Promise<Caller> {
  if (verifier === null) {
    if (DEPLOYED) {
      throw new Refusal(503, {
        error: 'server_error',
        error_description: 'This deployment has no OAuth configuration.',
      });
    }
    return { access: await requireAccess(context), scopes: new Set([SCOPE_READ, SCOPE_WRITE]) };
  }

  const header = context.request.headers.get('authorization') ?? '';
  const bearer = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (bearer === null) throw unauthorized(metadataUrl, 'A bearer access token is required');

  let payload: { sub?: unknown; scope?: unknown; auth_time?: unknown; username?: unknown };
  try {
    payload = await verifier.verify(bearer[1] ?? '');
  } catch {
    // Deliberately not relayed: the verifier's message distinguishes expiry
    // from a wrong audience from a bad signature, and that is a probing aid.
    throw unauthorized(metadataUrl, 'The access token is not valid');
  }

  const scopes = new Set(
    String(payload.scope ?? '')
      .split(' ')
      .filter((entry) => entry !== ''),
  );
  if (!scopes.has(SCOPE_READ)) throw insufficientScope(metadataUrl, SCOPE_READ);

  const token: TokenFacts = {
    sub: String(payload.sub ?? ''),
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : undefined,
    username: typeof payload.username === 'string' ? payload.username : '',
  };

  try {
    const access = await accessForUser(token.sub, (own, profile) =>
      federatedGate({ own, profile, token, metadataUrl }),
    );
    return { access, scopes };
  } catch (error: unknown) {
    throw asRefusal(error);
  }
}

/** Turn what the permission layers throw into the refusal a client reads. */
function asRefusal(error: unknown): unknown {
  if (error instanceof Refusal) return error;
  if (error instanceof NoAccessError) {
    return new Refusal(403, { error: 'access_denied', error_description: error.message });
  }
  if (error instanceof SyncBusyError) return temporarilyUnavailable(error.message);
  // The one refusal here that is not about the token at all: a Cognito
  // account that has never signed in to the Wiki has no directory record, so
  // there is nothing to resolve permissions from. Rephrased rather than
  // relayed, because "Unknown user" reads like a fault and the fix — sign in
  // to the Wiki once — is not something the reader would guess.
  if (error instanceof ApiError && error.status === 403) {
    return new Refusal(403, {
      error: 'access_denied',
      error_description:
        'This account is not known to the Wiki yet. Sign in to the Wiki once in a browser, then retry.',
    });
  }
  return error;
}

function temporarilyUnavailable(description: string): Refusal {
  return new Refusal(
    503,
    { error: 'temporarily_unavailable', error_description: description },
    { 'Retry-After': '5' },
  );
}

// ─── Federated accounts ──────────────────────────────────────────────────────
//
// A federated account's permissions come from its IdP's groups, which the
// pool copies into `custom:groups` each time the account signs in — through
// the browser or through the hosted sign-in an MCP client uses. The browser
// door applies them in its sign-in hook. Nothing else would, so this door
// applies them too: once per sign-in, when the token's `auth_time` is newer
// than the sign-in last applied.
//
// Two further rules hold here and nowhere else. A federated token is only
// accepted for a limited time after its sign-in, because a refresh does not go
// back to the IdP — without the limit, a person removed from a group there
// could go on refreshing for the full life of the refresh token. And an account
// left with no permission is refused on every request, which this door can do
// at no cost because it reads the account's edges on every request anyway.

/**
 * How long after its sign-in a federated account's token is accepted, in
 * seconds. Past it the client is sent back to the hosted sign-in, which asks
 * the IdP again and moves `auth_time`. Password accounts are not limited: the
 * Wiki itself is where their permissions are decided.
 */
export const FEDERATED_SIGN_IN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** What the gate needs from a verified access token. */
export type TokenFacts = { sub: string; authTime: number | undefined; username: string };

/** What `AdminGetUser` says about a pool user, reduced to what is checked. */
export type PoolUser = {
  sub: string | undefined;
  enabled: boolean;
  groups: string | undefined;
  identities: string | undefined;
};

/** The gate's outside world, so tests can stand in for Cognito and the table. */
export type GateDeps = {
  readPoolUser: (username: string) => Promise<PoolUser>;
  providerFor: (registration: string) => string | undefined;
  sync: typeof syncIdpGroups;
  nowMs: () => number;
};

let cognito: CognitoIdentityProviderClient | undefined;

async function readPoolUser(username: string): Promise<PoolUser> {
  // Bounded so a slow pool fails the request well inside the synchronisation
  // budget in `federation.ts`, rather than holding the lease past it.
  cognito ??= new CognitoIdentityProviderClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 4000 },
  });
  const result = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
  );
  const attribute = (name: string) =>
    result.UserAttributes?.find((entry) => entry.Name === name)?.Value;
  return {
    sub: attribute('sub'),
    enabled: result.Enabled !== false,
    groups: attribute('custom:groups'),
    identities: attribute('identities'),
  };
}

const defaultDeps: GateDeps = {
  readPoolUser,
  providerFor: providerForRegistration,
  sync: syncIdpGroups,
  nowMs: () => Date.now(),
};

/**
 * The bearer door's check on a federated account, run between hop 1 and the
 * rest of the permission walk (see `AccessGate` in `access.ts`).
 *
 * Password accounts pass untouched. A federated account is refused when its
 * sign-in is too old, has its role groups brought up to date when its sign-in
 * is newer than the one last applied, and is refused when it is left with no
 * permission. Returns the partition when the edges changed.
 */
export async function federatedGate(
  input: { own: Item[]; profile: Item; token: TokenFacts; metadataUrl: string },
  deps: GateDeps = defaultDeps,
): Promise<Item[] | undefined> {
  const { profile, token, metadataUrl } = input;
  const provider = profile.identityProvider;
  if (provider === undefined) return undefined;

  const { authTime } = token;
  if (
    authTime === undefined ||
    deps.nowMs() / 1000 - authTime > FEDERATED_SIGN_IN_MAX_AGE_SECONDS
  ) {
    throw unauthorized(metadataUrl, 'The sign-in behind this token is too old. Sign in again');
  }

  let own = input.own;
  let replaced: Item[] | undefined;
  const record = own.find((item) => item.type === 'IDP_SYNC');
  if (authTime > (record?.syncedAuthTime ?? 0)) {
    const result = await deps.sync({
      userId: token.sub,
      authTime,
      load: () => groupsFromPool(token, provider, deps),
    });
    // An applied synchronisation has already refused an account it left with
    // nothing, so only the other outcome is checked below.
    if (result.applied) return result.changed ? result.own : undefined;
    // Somebody else applied a sign-in at least as new while this request was
    // on its way; their result is what stands.
    own = result.own;
    replaced = result.own;
  }

  if (!hasEffectivePermission(own, directRoleGroups(own))) throw new NoAccessError();
  return replaced;
}

/**
 * The account's IdP groups as the pool holds them now, after checking that the
 * pool user is the token's and belongs to the IdP the directory says.
 *
 * Any doubt is a refusal rather than a pass on the edges already held: a
 * request let through on old edges is exactly what this door exists to stop.
 */
async function groupsFromPool(
  token: TokenFacts,
  provider: string,
  deps: GateDeps,
): Promise<{ provider: string; groups: string[] }> {
  let user: PoolUser;
  try {
    user = await deps.readPoolUser(token.username);
  } catch (error: unknown) {
    // Gone from the pool is not worth retrying: the account was deleted there.
    if (error instanceof Error && error.name === 'UserNotFoundException') {
      throw new Refusal(401, { error: 'invalid_token', error_description: 'This account no longer exists' });
    }
    console.error('[sl-wiki] Could not read a federated account from the user pool.', error);
    throw temporarilyUnavailable('The Wiki could not check this account. Retry shortly.');
  }
  if (!user.enabled) throw new Refusal(401, { error: 'invalid_token', error_description: 'This account is disabled' });
  if (user.sub !== token.sub || !registrationsOf(user.identities).some((name) => deps.providerFor(name) === provider)) {
    console.error('[sl-wiki] A federated token does not match its pool user.', {
      sub: token.sub,
      provider,
    });
    throw temporarilyUnavailable('The Wiki could not check this account. Retry shortly.');
  }
  return { provider, groups: groupsFromClaims({ groups: user.groups }, 'groups') };
}

/** The IdP registration names a pool user's `identities` attribute lists. */
export function registrationsOf(identities: string | undefined): string[] {
  if (identities === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(identities);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: unknown) =>
        typeof entry === 'object' && entry !== null
          ? (entry as { providerName?: unknown }).providerName
          : undefined,
      )
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

/**
 * Refuse a request whose `Origin` is not this deployment's own.
 *
 * An MCP client is not a browser and sends no `Origin` at all, so this only
 * bites on a cross-site request made from a page — which, since the local
 * development path authenticates by cookie, is worth refusing.
 *
 * What it is compared against matters. With `MCP_PUBLIC_ORIGIN` set it is a
 * fixed value, and the check is a real one. Without it the comparison is
 * against the request's own `Host`, which the caller also controls — so it
 * would not by itself stop DNS rebinding (repointing a name the browser already
 * trusts at this server). What stops that in practice is the layer in front:
 * API Gateway and CloudFront only answer for their own names, and locally only
 * `localhost` resolves here.
 */
export function guardOrigin(context: BlocksContext, surface: string): void {
  const origin = context.request.headers.get('origin');
  if (origin === null || origin === '') return;
  const allowed = PUBLIC_ORIGIN !== '' ? PUBLIC_ORIGIN : context.request.url.origin;
  if (origin !== allowed) {
    throw new Refusal(403, {
      error: 'invalid_origin',
      error_description: `This origin may not reach the ${surface} endpoint.`,
    });
  }
}

/** Apply a `Refusal`; anything else is left to the caller's route wrapper. */
export function sendRefusal(context: BlocksContext, error: unknown): boolean {
  if (!(error instanceof Refusal)) return false;
  context.response.status = error.status;
  for (const [name, value] of Object.entries(error.extraHeaders)) {
    context.response.headers.set(name, value);
  }
  context.response.send(error.body);
  return true;
}

// ─── RFC 9728 metadata ───────────────────────────────────────────────────────

/**
 * What protects one resource path, and which authorization server issues for it.
 *
 * `authorization_servers` names the Wiki's own origin rather than Cognito's,
 * because the Wiki is what writes the RFC 8414 document a client reads next —
 * see the header of `mcp.ts` for why it cannot be Cognito's.
 */
export function protectedResourceDocument(base: string, resourcePath: string) {
  return {
    resource: `${base}${resourcePath}`,
    authorization_servers: [base],
    scopes_supported: [SCOPE_READ, SCOPE_WRITE],
    bearer_methods_supported: ['header'],
    resource_name: 'sl-wiki',
  };
}

/**
 * Bearer token authentication, shared by every surface reached without a
 * browser.
 *
 * Two such surfaces exist: the MCP server at `/mcp`, which AI clients speak to,
 * and the sync API at `/ext/*`, which the Obsidian plugin speaks to. They serve
 * different callers and different payload shapes, but they answer to the same
 * user pool, the same two scopes, and the same permission walk — so the code
 * that decides *who is calling* lives here rather than in either of them. A
 * second copy could drift, and the copy that drifted would be an authorization
 * decision made two ways.
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
import { ApiError, type BlocksContext } from '@aws-blocks/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { type Access, accessForUser, requireAccess } from './access.js';

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
 * The URL this Wiki is reached at from outside, when the request cannot say.
 *
 * Behind CloudFront it cannot. `Hosting` fronts the API with an origin request
 * policy that forwards every viewer header *except* `Host`, so what arrives at
 * the Lambda is the API Gateway's own domain and stage — not the address the
 * client typed. Metadata built from that names an endpoint the client never
 * connected to, and RFC 9728 has the client check exactly that, so discovery
 * fails. The distribution's domain cannot be injected from CDK either: the
 * distribution points at the API, which points at this Lambda, so feeding it
 * back into the Lambda's environment is a CloudFormation cycle.
 *
 * So it is the operator's to supply, on any deployment where something sits in
 * front of the API — a CDN, a custom domain, both:
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

/** The realm both surfaces name in `WWW-Authenticate`. */
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

/** True inside Lambda, where the runtime always sets this. Never true locally. */
const IN_LAMBDA = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

// ─── HTTP-level refusals ─────────────────────────────────────────────────────

/**
 * A refusal that has to carry its own status and headers.
 *
 * `ApiError` covers everything the Wiki's own layers refuse, and each surface's
 * route wrapper already turns one into the right status. This exists for the
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
 * `MCP_PUBLIC_ORIGIN` wins when it is set, because on the deployment shape that
 * needs it the request is not able to say (see the constant). Otherwise the
 * request is the answer: the framework has already folded the API Gateway stage
 * prefix and `x-forwarded-proto` back into `request.url`, so what is left is to
 * remove the route's own path.
 */
export function baseUrl(context: BlocksContext, suffix: string): string {
  if (PUBLIC_ORIGIN !== '') return PUBLIC_ORIGIN;
  const { origin, pathname } = context.request.url;
  return pathname.endsWith(suffix) ? origin + pathname.slice(0, -suffix.length) : origin;
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
 * `metadataUrl` is where the calling surface tells clients to look for its own
 * RFC 9728 document; it only ever ends up inside a refusal header.
 *
 * ─── The local-development path ─────────────────────────────────────────────
 * Without a user pool there is nothing to verify a token against, so local
 * development authenticates the same way the UI does — the session cookie, via
 * `requireAccess`. This is a real sign-in, not a bypass, and it is unreachable
 * on AWS twice over: `index.cdk.ts` always sets the three variables, and the
 * branch additionally refuses to run inside Lambda. It exists so the e2e suite
 * can drive both surfaces, including the permission refusals, against the local
 * mock.
 */
export async function authenticate(
  context: BlocksContext,
  metadataUrl: string,
): Promise<Caller> {
  if (verifier === null) {
    if (IN_LAMBDA) {
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

  let payload: { sub?: unknown; scope?: unknown };
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

  try {
    return { access: await accessForUser(String(payload.sub ?? '')), scopes };
  } catch (error: unknown) {
    // The one refusal here that is not about the token at all: a Cognito
    // account that has never signed in to the Wiki has no directory record, so
    // there is nothing to resolve permissions from. Rephrased rather than
    // relayed, because "Unknown user" reads like a fault and the fix — sign in
    // to the Wiki once — is not something the reader would guess.
    if (error instanceof ApiError && error.status === 403) {
      throw new Refusal(403, {
        error: 'access_denied',
        error_description:
          'This account is not known to the Wiki yet. Sign in to the Wiki once in a browser, then retry.',
      });
    }
    throw error;
  }
}

/**
 * Refuse a request whose `Origin` is not this deployment's own.
 *
 * Neither an MCP client nor the sync plugin is a browser, and neither sends an
 * `Origin` at all, so this only bites on a cross-site request made from a page
 * — which, since the local development path authenticates by cookie, is worth
 * refusing.
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
 * Both surfaces answer with this same document under their own path, differing
 * only in `resource`. `authorization_servers` names the Wiki's own origin rather
 * than Cognito's, because the Wiki is what writes the RFC 8414 document a client
 * reads next — see the header of `mcp.ts` for why it cannot be Cognito's.
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

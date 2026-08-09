/**
 * Getting and keeping an access token for the sync API.
 *
 * The Wiki's bearer surfaces answer to Cognito, and Cognito hands tokens to a
 * public client only through a browser: authorization code with PKCE, no client
 * secret, no direct authentication flow. So the plugin cannot ask for a password
 * — it opens the system browser, and the answer has to find its way back.
 *
 * ─── Why the answer comes back over `obsidian://` ────────────────────────────
 * The other way a native client receives a code is a loopback redirect, which
 * means standing up an HTTP server for the few seconds of the sign-in. Obsidian
 * gives a plugin something better: it registers `obsidian://` with the operating
 * system, so a redirect to `obsidian://slwiki-auth?code=…` reopens the app and is
 * handed to `registerObsidianProtocolHandler`. No server, and nothing that only
 * works on desktop.
 *
 * The redirect URI is matched whole by Cognito, so `slwiki-auth` here and
 * `OBSIDIAN_CALLBACK_URL` in `aws-blocks/index.cdk.ts` have to stay identical.
 *
 * ─── What is discovered and what is configured ──────────────────────────────
 * The endpoints are read from the Wiki's own RFC 8414 document, so the Cognito
 * sign-in domain never has to be typed in. The client id cannot be: this
 * deployment has no dynamic client registration, and the id differs per stack.
 * It is the `McpClientId` stack output.
 */
import { requestUrl } from 'obsidian';

import { t } from './i18n';
import { type Identity, type SettingsHost, type StoredTokens, normalizeUrl } from './settings';

/** The action half of the callback URI; must match Cognito's registration. */
export const PROTOCOL_ACTION = 'slwiki-auth';

/** The redirect URI, spelled exactly as `index.cdk.ts` registers it. */
export const CALLBACK_URL = `obsidian://${PROTOCOL_ACTION}`;

/** Both scopes are asked for; a user without write permission still gets them. */
const SCOPES = 'slwiki/read slwiki/write';

/** Refresh this long before expiry, so a request in flight does not race it. */
const REFRESH_MARGIN_MS = 60_000;

/** How long a started sign-in waits for the browser to come back. */
const PENDING_TTL_MS = 10 * 60_000;

/** A failure with a message written for the person who pressed the button. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The endpoints, as the Wiki's discovery document gives them. */
type AuthorizationServer = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
};

/** A sign-in that has been started and not yet answered. */
type Pending = {
  verifier: string;
  state: string;
  startedAt: number;
};

export class AuthClient {
  /**
   * The PKCE verifier of a sign-in in progress, held in memory only.
   *
   * Not persisted deliberately. It is a secret with a lifetime of one browser
   * round trip, and writing it to `data.json` would leave it in the vault long
   * after it stopped being useful. The cost is that quitting Obsidian mid
   * sign-in loses the attempt, which the user recovers from by pressing the
   * button again.
   */
  private pending: Pending | null = null;

  /** Discovery result, cached per Wiki URL for the life of the process. */
  private discovered: { wikiUrl: string; server: AuthorizationServer } | null = null;

  /** The refresh in flight, so concurrent callers wait on one exchange. */
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly host: SettingsHost,
    /** Called after any change to the stored tokens, to redraw the settings. */
    private readonly onChange: () => void,
  ) {}

  get signedIn(): boolean {
    return this.host.settings.tokens !== null;
  }

  // ─── The sign-in round trip ────────────────────────────────────────────────

  /** Open the browser at Cognito's sign-in screen. */
  async beginSignIn(): Promise<void> {
    const { wikiUrl, clientId } = this.requireConfig();
    const server = await this.authorizationServer(wikiUrl);

    const verifier = randomString(64);
    const state = randomString(32);
    this.pending = { verifier, state, startedAt: Date.now() };

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK_URL,
      scope: SCOPES,
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    });
    window.open(`${server.authorizationEndpoint}?${query.toString()}`, '_blank');
  }

  /**
   * Handle `obsidian://slwiki-auth?…`, whatever it carries.
   *
   * The `state` check is what makes this handler safe to leave registered: the
   * URI scheme is open to anything on the machine that can ask the OS to open a
   * URL, so a code arriving without a matching in-memory `state` is not an
   * answer to a sign-in this plugin started, and is dropped.
   */
  async handleCallback(params: Record<string, string | undefined>): Promise<void> {
    const pending = this.pending;
    this.pending = null;

    if (params.error !== undefined && params.error !== '') {
      throw new AuthError(t.signInNotCompleted(params.error_description ?? params.error));
    }
    if (pending === null || Date.now() - pending.startedAt > PENDING_TTL_MS) {
      throw new AuthError(t.noPendingSignIn);
    }
    if (params.state !== pending.state) {
      throw new AuthError(t.signInMismatch);
    }
    const code = params.code;
    if (code === undefined || code === '') {
      throw new AuthError(t.signInNoCode);
    }

    const { wikiUrl, clientId } = this.requireConfig();
    const server = await this.authorizationServer(wikiUrl);
    const granted = await this.exchange(server.tokenEndpoint, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: pending.verifier,
    });

    if (granted.refresh_token === undefined) {
      throw new AuthError(t.noRefreshToken);
    }
    await this.store({
      accessToken: granted.access_token,
      expiresAt: Date.now() + granted.expires_in * 1000,
      refreshToken: granted.refresh_token,
    });
  }

  // ─── Using and renewing the token ──────────────────────────────────────────

  /** A token good for at least the next minute, refreshing if it is not. */
  async accessToken(): Promise<string> {
    const tokens = this.host.settings.tokens;
    if (tokens === null) {
      throw new AuthError(t.notSignedIn);
    }
    if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) return tokens.accessToken;
    return await this.refresh();
  }

  /**
   * Exchange the refresh token for a new access token.
   *
   * Also the recovery path for a 401 on a token this plugin still believed in —
   * a token revoked at Cognito expires early as far as the server is concerned,
   * and nothing here would know until a request came back refused.
   */
  async refresh(): Promise<string> {
    if (this.refreshing !== null) return await this.refreshing;
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return await this.refreshing;
  }

  private async runRefresh(): Promise<string> {
    const tokens = this.host.settings.tokens;
    if (tokens === null) throw new AuthError(t.notSignedIn);
    const { wikiUrl, clientId } = this.requireConfig();
    const server = await this.authorizationServer(wikiUrl);

    let granted;
    try {
      granted = await this.exchange(server.tokenEndpoint, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refreshToken,
      });
    } catch (error: unknown) {
      // A refresh token that Cognito no longer accepts is not a transient
      // failure, and keeping it would make every later call fail the same slow
      // way. Clearing it puts the plugin back in the state whose remedy the
      // settings screen already offers.
      if (error instanceof AuthError && /invalid_grant/.test(error.message)) {
        await this.store(null);
        throw new AuthError(t.signInExpired);
      }
      throw error;
    }

    // Cognito reissues only the access token here; the refresh token stands
    // until it expires or is revoked, so it is carried across unchanged.
    await this.store({
      accessToken: granted.access_token,
      expiresAt: Date.now() + granted.expires_in * 1000,
      refreshToken: granted.refresh_token ?? tokens.refreshToken,
    });
    return granted.access_token;
  }

  /**
   * Forget the tokens, and tell Cognito to stop honouring the refresh token.
   *
   * Revocation is attempted first but never allowed to keep the local half from
   * happening: a user pressing "Sign out" wants the token out of their vault,
   * and an unreachable network is not a reason to leave it there.
   */
  async signOut(): Promise<void> {
    const tokens = this.host.settings.tokens;
    const { wikiUrl, clientId } = this.config();
    if (tokens !== null && wikiUrl !== '' && clientId !== '') {
      try {
        const server = await this.authorizationServer(wikiUrl);
        if (server.revocationEndpoint !== null) {
          await postForm(server.revocationEndpoint, {
            token: tokens.refreshToken,
            client_id: clientId,
          });
        }
      } catch {
        // Reported by leaving it out of the message; the local clear is what
        // the user asked for and it always happens.
      }
    }
    await this.store(null);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The two configured values, tidied at the point of use.
   *
   * Tidying here rather than as the settings field is edited: stripping trailing
   * slashes from what someone is still typing turns `https://` into `https:`
   * between two keystrokes.
   */
  private config(): { wikiUrl: string; clientId: string } {
    return {
      wikiUrl: normalizeUrl(this.host.settings.wikiUrl),
      clientId: this.host.settings.clientId.trim(),
    };
  }

  private requireConfig(): { wikiUrl: string; clientId: string } {
    const config = this.config();
    if (config.wikiUrl === '' || config.clientId === '') {
      throw new AuthError(t.configMissing);
    }
    return config;
  }

  /** Read (once per Wiki URL) the RFC 8414 document the Wiki publishes. */
  private async authorizationServer(wikiUrl: string): Promise<AuthorizationServer> {
    if (this.discovered !== null && this.discovered.wikiUrl === wikiUrl) {
      return this.discovered.server;
    }
    const url = `${wikiUrl}/.well-known/oauth-authorization-server`;
    let response;
    try {
      response = await requestUrl({ url, method: 'GET', throw: false });
    } catch (error: unknown) {
      throw new AuthError(t.discoveryUnreachable(url, describe(error)));
    }
    if (response.status !== 200) {
      throw new AuthError(t.discoveryStatus(url, response.status));
    }
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(response.text) as Record<string, unknown>;
    } catch {
      throw new AuthError(t.discoveryNotJson(url));
    }
    const authorizationEndpoint = document.authorization_endpoint;
    const tokenEndpoint = document.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new AuthError(t.discoveryNoEndpoints(url));
    }
    const server: AuthorizationServer = {
      authorizationEndpoint,
      tokenEndpoint,
      revocationEndpoint:
        typeof document.revocation_endpoint === 'string' ? document.revocation_endpoint : null,
    };
    this.discovered = { wikiUrl, server };
    return server;
  }

  /** POST to the token endpoint and read the grant, or the refusal. */
  private async exchange(
    tokenEndpoint: string,
    form: Record<string, string>,
  ): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const response = await postForm(tokenEndpoint, form);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(response.text) as Record<string, unknown>;
    } catch {
      // Left empty; the status below carries the message instead.
    }
    if (response.status !== 200) {
      const code = typeof body.error === 'string' ? body.error : String(response.status);
      const detail = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
      throw new AuthError(t.tokenRequestFailed(`${code}${detail}`));
    }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new AuthError(t.tokenResponseUnexpected);
    }
    return {
      access_token: body.access_token,
      expires_in: body.expires_in,
      ...(typeof body.refresh_token === 'string' ? { refresh_token: body.refresh_token } : {}),
    };
  }

  private async store(tokens: StoredTokens | null): Promise<void> {
    this.host.settings.tokens = tokens;
    this.host.settings.identity = tokens === null ? null : identityOf(tokens.accessToken);
    await this.host.saveSettings();
    this.onChange();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** POST an `application/x-www-form-urlencoded` body, without throwing on 4xx. */
async function postForm(url: string, form: Record<string, string>) {
  return await requestUrl({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    throw: false,
  });
}

/**
 * What the access token says about itself, read without verifying it.
 *
 * Safe because nothing is decided on it: the Wiki verifies the signature on
 * every request, and this is only what the settings screen displays. Reading
 * the granted scopes is worth the decode — a user whose token came back without
 * `slwiki/write` can see that before a push is refused.
 */
function identityOf(accessToken: string): Identity | null {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
    return {
      username: typeof claims.username === 'string' ? claims.username : '',
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  if (crypto.subtle === undefined) {
    throw new AuthError(t.webCryptoMissing);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

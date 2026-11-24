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
 * `OBSIDIAN_CALLBACK_URL` in `cdk-blocks/index.cdk.ts` have to stay identical.
 *
 * ─── What is discovered and what is configured ──────────────────────────────
 * The endpoints are read from the Wiki's own RFC 8414 document, so the Cognito
 * sign-in domain never has to be typed in. The client id cannot be: this
 * deployment has no dynamic client registration, and the id differs per stack.
 * It is the `McpClientId` stack output.
 *
 * ─── Which Wiki a token belongs to ──────────────────────────────────────────
 * Tokens are stored with the Wiki URL, the client id and the endpoints they
 * were issued under (`TokenIssuer`), and nothing here sends a token anywhere
 * until the settings are found to still name that same Wiki and client. A
 * changed address reads as "signed out" rather than as somewhere new to send
 * the old Wiki's tokens, and refresh and revocation go to the endpoints
 * recorded at sign-in, never to ones a different address advertises. The
 * tokens are not cleared when the address changes: the settings are saved on
 * every keystroke, and putting the old address back restores the sign-in.
 */
import { requestUrl } from 'obsidian';

import { t } from './i18n';
import {
  type Identity,
  type SettingsHost,
  type StoredTokens,
  type TokenIssuer,
  connectionOf,
  issuedFor,
} from './settings';

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
  /**
   * The Wiki, client and endpoints the sign-in was started against.
   *
   * The answer is exchanged with these and not with what the settings say by
   * the time the browser comes back, so the code goes to the token endpoint of
   * the same Wiki that issued it, and the tokens are recorded as that Wiki's.
   */
  wikiUrl: string;
  clientId: string;
  server: AuthorizationServer;
};

/**
 * An access token together with the Wiki it may be sent to.
 *
 * Handed out as one value so that a caller cannot pair a token with an address
 * read from somewhere else (`api.ts`).
 */
export type Credential = {
  wikiUrl: string;
  accessToken: string;
};

/** Stored tokens that carry their issuer. */
type BoundTokens = StoredTokens & { issuer: TokenIssuer };

/**
 * Asked before signing in to a new address with the client id of the old one.
 *
 * Resolves true to go ahead. A Wiki that really moved normally comes with a new
 * client id as well, so the same id at a different address is worth a second
 * look: it is also what pasting a look-alike address over the real one looks
 * like.
 */
export type ConfirmMove = (from: string, to: string) => Promise<boolean>;

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
  private refreshing: Promise<Credential> | null = null;

  constructor(
    private readonly host: SettingsHost,
    /** Called after any change to the stored tokens, to redraw the settings. */
    private readonly onChange: () => void,
  ) {}

  /** Whether there are tokens that may be used with the settings as they stand. */
  get signedIn(): boolean {
    return this.usable() !== null;
  }

  /**
   * The Wiki the stored tokens belong to, when it is not the one the settings
   * now name — for the settings screen to say why it reads as signed out.
   */
  get otherIssuer(): string | null {
    const tokens = this.host.settings.tokens;
    if (tokens === null || tokens.issuer === null) return null;
    if (issuedFor(tokens.issuer, this.host.settings)) return null;
    return tokens.issuer.wikiUrl;
  }

  /** Whether the stored tokens are an earlier version's, still without an issuer. */
  get legacy(): boolean {
    return this.host.settings.tokens !== null && this.host.settings.tokens.issuer === null;
  }

  /**
   * Give tokens an earlier version stored the issuer they were never recorded
   * with, so they can be used — and revoked.
   *
   * That version wrote the tokens and the settings to the same file at the same
   * time, so the Wiki the settings name is the one they came from unless the
   * settings were changed under it; and that version would have sent them there
   * on its next cycle anyway. The endpoints are taken from that Wiki's
   * discovery document under the same checks a sign-in applies. Returns
   * whether the tokens now have an issuer; a failure leaves them as they were,
   * unused, for the next attempt or for a sign-out.
   */
  async adoptLegacy(): Promise<boolean> {
    const tokens = this.host.settings.tokens;
    if (tokens === null || tokens.issuer !== null) return false;
    const { wikiUrl, clientId } = connectionOf(this.host.settings);
    if (wikiUrl === '' || clientId === '') return false;
    let server: AuthorizationServer;
    try {
      server = await this.authorizationServer(wikiUrl);
    } catch {
      return false;
    }
    // Replaced while discovery was out; whatever is there now is not these.
    if (this.host.settings.tokens !== tokens) return false;
    await this.store({
      ...tokens,
      issuer: {
        wikiUrl,
        clientId,
        tokenEndpoint: server.tokenEndpoint,
        revocationEndpoint: server.revocationEndpoint,
      },
    });
    return true;
  }

  // ─── The sign-in round trip ────────────────────────────────────────────────

  /**
   * Open the browser at Cognito's sign-in screen.
   *
   * When the stored tokens came from another address under the same client
   * id, `confirmMove` is asked first, and nothing is fetched from the new
   * address unless it says yes.
   */
  async beginSignIn(confirmMove: ConfirmMove): Promise<void> {
    const { wikiUrl, clientId } = this.requireConfig();
    const previous = this.host.settings.tokens?.issuer ?? null;
    if (previous !== null && previous.clientId === clientId && previous.wikiUrl !== wikiUrl) {
      if (!(await confirmMove(previous.wikiUrl, wikiUrl))) {
        throw new AuthError(t.signInMoveDeclined);
      }
    }
    const server = await this.authorizationServer(wikiUrl);

    const verifier = randomString(64);
    const state = randomString(32);
    this.pending = { verifier, state, startedAt: Date.now(), wikiUrl, clientId, server };

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

    const { wikiUrl, clientId, server } = pending;
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
      issuer: {
        wikiUrl,
        clientId,
        tokenEndpoint: server.tokenEndpoint,
        revocationEndpoint: server.revocationEndpoint,
      },
    });
  }

  // ─── Using and renewing the token ──────────────────────────────────────────

  /**
   * A token good for at least the next minute, and the Wiki it is for.
   *
   * Refreshes first when the token is about to expire. Refuses, sending
   * nothing, when the stored tokens belong to a Wiki or client other than the
   * one the settings now name.
   */
  async credential(): Promise<Credential> {
    const tokens = this.requireUsable();
    if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
      return { wikiUrl: tokens.issuer.wikiUrl, accessToken: tokens.accessToken };
    }
    return await this.refreshed(tokens.issuer.wikiUrl);
  }

  /**
   * A new access token for the same Wiki as `previous`.
   *
   * The recovery path for a 401 on a token this plugin still believed in — a
   * token revoked at Cognito expires early as far as the server is concerned,
   * and nothing here would know until a request came back refused. The retry
   * is only ever sent where the first request went: if the settings or the
   * sign-in changed while the first request was out, this refuses rather than
   * exchanging one Wiki's refresh token on behalf of a request to another.
   */
  async refreshFor(previous: Credential): Promise<Credential> {
    const tokens = this.requireUsable();
    if (tokens.issuer.wikiUrl !== previous.wikiUrl) throw new AuthError(t.notSignedIn);
    return await this.refreshed(previous.wikiUrl);
  }

  /** Run (or join) a refresh and check it still answers for `wikiUrl`. */
  private async refreshed(wikiUrl: string): Promise<Credential> {
    if (this.refreshing === null) {
      this.refreshing = this.runRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    const credential = await this.refreshing;
    // Re-checked after the wait: the settings may have been edited, or another
    // account signed in, while the exchange was out.
    if (credential.wikiUrl !== wikiUrl || this.usable()?.issuer.wikiUrl !== wikiUrl) {
      throw new AuthError(t.notSignedIn);
    }
    return credential;
  }

  private async runRefresh(): Promise<Credential> {
    const tokens = this.requireUsable();
    const { issuer } = tokens;

    let granted;
    try {
      // The endpoint recorded at sign-in, not one discovered now: the address
      // in the settings is only trusted as far as it matches the issuer, and
      // the issuer's own endpoint needs no second opinion.
      granted = await this.exchange(issuer.tokenEndpoint, {
        grant_type: 'refresh_token',
        client_id: issuer.clientId,
        refresh_token: tokens.refreshToken,
      });
    } catch (error: unknown) {
      // A refresh token that Cognito no longer accepts is not a transient
      // failure, and keeping it would make every later call fail the same slow
      // way. Clearing it puts the plugin back in the state whose remedy the
      // settings screen already offers — unless the tokens were replaced while
      // the request was out, in which case they are not the ones refused.
      if (error instanceof AuthError && /invalid_grant/.test(error.message)) {
        if (this.host.settings.tokens === tokens) await this.store(null);
        throw new AuthError(t.signInExpired);
      }
      throw error;
    }

    // A sign-out or a new sign-in finished while this was out. Storing now
    // would bring back the tokens the user just got rid of, or overwrite the
    // ones they just got.
    if (this.host.settings.tokens !== tokens) throw new AuthError(t.notSignedIn);

    // Cognito reissues only the access token here; the refresh token stands
    // until it expires or is revoked, so it is carried across unchanged.
    await this.store({
      accessToken: granted.access_token,
      expiresAt: Date.now() + granted.expires_in * 1000,
      refreshToken: granted.refresh_token ?? tokens.refreshToken,
      issuer,
    });
    return { wikiUrl: issuer.wikiUrl, accessToken: granted.access_token };
  }

  /**
   * Forget the tokens, and tell Cognito to stop honouring the refresh token.
   *
   * Revocation is attempted first but never allowed to keep the local half from
   * happening: a user pressing "Sign out" wants the token out of their vault,
   * and an unreachable network is not a reason to leave it there.
   *
   * Revocation is sent only while the settings still name the Wiki the tokens
   * came from, and only to the endpoint recorded at sign-in. Tokens from a Wiki
   * the settings no longer name are forgotten without a word to anyone, since
   * the only address on hand is one they must not be sent to. Tokens an
   * earlier version left without an issuer are given one first, if they can
   * be, so that they are revoked too.
   */
  async signOut(): Promise<void> {
    if (this.legacy) await this.adoptLegacy();
    const tokens = this.usable();
    if (tokens !== null && tokens.issuer.revocationEndpoint !== null) {
      try {
        await postForm(tokens.issuer.revocationEndpoint, {
          token: tokens.refreshToken,
          client_id: tokens.issuer.clientId,
        });
      } catch {
        // Reported by leaving it out of the message; the local clear is what
        // the user asked for and it always happens.
      }
    }
    await this.store(null);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** The stored tokens, when the settings still name the Wiki that issued them. */
  private usable(): BoundTokens | null {
    const tokens = this.host.settings.tokens;
    if (tokens === null || tokens.issuer === null) return null;
    return issuedFor(tokens.issuer, this.host.settings) ? (tokens as BoundTokens) : null;
  }

  private requireUsable(): BoundTokens {
    const tokens = this.usable();
    if (tokens === null) throw new AuthError(t.notSignedIn);
    return tokens;
  }

  /**
   * The two configured values, tidied at the point of use.
   *
   * Tidying here rather than as the settings field is edited: stripping trailing
   * slashes from what someone is still typing turns `https://` into `https:`
   * between two keystrokes.
   */
  private requireConfig(): { wikiUrl: string; clientId: string } {
    const config = connectionOf(this.host.settings);
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
    const revocationEndpoint =
      typeof document.revocation_endpoint === 'string' ? document.revocation_endpoint : null;
    // The refresh token is posted to these, so they have to be one
    // authorization server over TLS: a document that splits them across
    // origins, or names a plain-http one, is not trusted with it.
    const endpoints = [authorizationEndpoint, tokenEndpoint, revocationEndpoint].filter(
      (endpoint): endpoint is string => endpoint !== null,
    );
    const origins = new Set(endpoints.map(httpsOrigin));
    if (origins.has(null) || origins.size !== 1) {
      throw new AuthError(t.discoveryUntrusted(url));
    }
    const server: AuthorizationServer = { authorizationEndpoint, tokenEndpoint, revocationEndpoint };
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

/** The origin of an `https:` URL, or null for anything else. */
function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

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

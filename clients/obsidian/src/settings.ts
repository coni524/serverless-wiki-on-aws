/**
 * What the plugin stores, and where it stores it.
 *
 * The settings land in `<vault>/.obsidian/plugins/slwiki-sync/data.json`. The
 * tokens do not, wherever Obsidian offers somewhere better: from 1.11.4 on, the
 * app's secret storage holds them, outside the vault, and `data.json` is written
 * without them (`token-store.ts`). An older Obsidian has no such place, and
 * there the tokens stay in `data.json` in clear text, which the settings screen
 * says out loud: a vault carried by another sync service (iCloud, Dropbox)
 * carries the token with it.
 */

/**
 * The Wiki and the client a set of tokens was issued for.
 *
 * Recorded at sign-in and compared with the settings before a token is used.
 * A token is only ever sent to the Wiki it came from: changing the Wiki URL in
 * the settings must not hand the old Wiki's tokens to the new address, and the
 * refresh and revocation requests go to the endpoints discovered at sign-in
 * rather than to whatever the current address advertises.
 */
export type TokenIssuer = {
  /** The Wiki URL at sign-in, normalised (`normalizeUrl`). */
  wikiUrl: string;
  /** The app client id at sign-in, trimmed. */
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
};

/** Tokens from the last completed sign-in. */
export type StoredTokens = {
  accessToken: string;
  /** When the access token stops being accepted, as epoch milliseconds. */
  expiresAt: number;
  /**
   * The long-lived half. Cognito does not reissue it on refresh, so this is the
   * value from the original authorization code exchange until it expires (30
   * days, `index.cdk.ts`) or the user signs out.
   */
  refreshToken: string;
  /**
   * Who issued them.
   *
   * Null for tokens an earlier version stored without one. Those are not used
   * as they are: the plugin first attaches the Wiki the settings name, once its
   * discovery document passes the same checks a sign-in does (`AuthClient.
   * adoptLegacy`). Until then they are kept, unused, so that signing out can
   * still revoke them.
   */
  issuer: TokenIssuer | null;
};

/** What the access token says about itself, kept only to show in the settings. */
export type Identity = {
  /** The Cognito username the token was issued for. */
  username: string;
  /** The scopes actually granted, which may be narrower than those asked for. */
  scopes: string[];
};

export type SlWikiSettings = {
  /** The deployment's public address, without a trailing slash. */
  wikiUrl: string;
  /** The Cognito app client id — the stack output `McpClientId`. */
  clientId: string;
  tokens: StoredTokens | null;
  identity: Identity | null;
  /**
   * The spaces mirrored into the vault, by id.
   *
   * Ids and not names: a space renamed in the Wiki stays the same space, and
   * the mirror follows the new name by renaming its folder.
   */
  syncedSpaceIds: string[];
  /**
   * The spaces where deleting a note deletes the page in the Wiki.
   *
   * Off for every space until the user says otherwise, and named separately
   * rather than as a flag on the sync list because the two decisions are not
   * the same size: mirroring a space is undone by unchecking it, while a page
   * deleted in the Wiki goes to the reclamation job and takes its bodies in S3
   * with it. A note deleted in a space that is not named here comes
   * back on the next cycle.
   */
  pushDeleteSpaceIds: string[];
  /** Minutes between automatic cycles; 0 turns the timer off. */
  syncIntervalMinutes: number;
  /**
   * Space id → the existing folder the user agreed to import on the space's
   * first cycle.
   *
   * A space seen for the first time whose folder already holds something is
   * paused instead of synced: every note in that folder would otherwise be sent
   * to the space as a new page, and the folder may be one the user never meant
   * to share. The folder name is kept along with the id, so a confirmation
   * given for one folder is not taken as one for another after the space is
   * renamed. Used once and then removed.
   */
  adoptFolders: Record<string, string>;
};

export const DEFAULT_SETTINGS: SlWikiSettings = {
  wikiUrl: '',
  clientId: '',
  tokens: null,
  identity: null,
  syncedSpaceIds: [],
  pushDeleteSpaceIds: [],
  syncIntervalMinutes: 5,
  adoptFolders: {},
};

/**
 * The part of the plugin the authentication and API layers are allowed to touch.
 *
 * Narrower than the plugin itself so those two modules cannot reach into the
 * workspace or the vault, and so neither has to import `main.ts` back.
 */
export interface SettingsHost {
  settings: SlWikiSettings;
  saveSettings(): Promise<void>;
}

/** Strip the trailing slashes a URL typed into a settings field usually has. */
export function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** The two connection settings, tidied the way the issuer records them. */
export function connectionOf(settings: SlWikiSettings): { wikiUrl: string; clientId: string } {
  return { wikiUrl: normalizeUrl(settings.wikiUrl), clientId: settings.clientId.trim() };
}

/**
 * Whether tokens from `issuer` may be used with the settings as they now stand.
 *
 * Tokens without an issuer are answered no: they are not used until one has
 * been attached to them.
 */
export function issuedFor(issuer: TokenIssuer | null | undefined, settings: SlWikiSettings): boolean {
  if (issuer === undefined || issuer === null) return false;
  const current = connectionOf(settings);
  return (
    current.wikiUrl !== '' &&
    current.clientId !== '' &&
    current.wikiUrl === issuer.wikiUrl &&
    current.clientId === issuer.clientId
  );
}

/**
 * Tokens as read back from storage, or null when they are not tokens at all.
 *
 * Tokens an earlier version stored without their issuer come back with a null
 * one rather than being dropped: they stay unused until an issuer is attached,
 * and keeping them is what lets a sign-out revoke them. An issuer that is
 * present but malformed is not a legacy record but a damaged one, and the
 * whole set is dropped.
 */
export function readTokens(value: unknown): StoredTokens | null {
  if (typeof value !== 'object' || value === null) return null;
  const tokens = value as Record<string, unknown>;
  const issuer = tokens.issuer as Record<string, unknown> | null | undefined;
  if (
    typeof tokens.accessToken !== 'string' ||
    typeof tokens.refreshToken !== 'string' ||
    typeof tokens.expiresAt !== 'number'
  ) {
    return null;
  }
  if (issuer === undefined || issuer === null) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      issuer: null,
    };
  }
  if (
    typeof issuer !== 'object' ||
    typeof issuer.wikiUrl !== 'string' ||
    issuer.wikiUrl === '' ||
    typeof issuer.clientId !== 'string' ||
    issuer.clientId === '' ||
    typeof issuer.tokenEndpoint !== 'string' ||
    issuer.tokenEndpoint === '' ||
    (issuer.revocationEndpoint !== null && typeof issuer.revocationEndpoint !== 'string')
  ) {
    return null;
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    issuer: {
      wikiUrl: issuer.wikiUrl,
      clientId: issuer.clientId,
      tokenEndpoint: issuer.tokenEndpoint,
      revocationEndpoint: issuer.revocationEndpoint,
    },
  };
}

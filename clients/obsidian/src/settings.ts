/**
 * What the plugin stores, and where it stores it.
 *
 * All of it lands in one file, `<vault>/.obsidian/plugins/slwiki-sync/data.json`,
 * because that is the only persistence Obsidian offers a plugin. The refresh
 * token is in there in clear text, which the settings screen says out loud: a
 * vault carried by another sync service (iCloud, Dropbox) carries the token with
 * it.
 */

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
};

export const DEFAULT_SETTINGS: SlWikiSettings = {
  wikiUrl: '',
  clientId: '',
  tokens: null,
  identity: null,
  syncedSpaceIds: [],
  pushDeleteSpaceIds: [],
  syncIntervalMinutes: 5,
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

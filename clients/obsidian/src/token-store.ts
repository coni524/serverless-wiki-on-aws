/**
 * Where the tokens are kept, which is not `data.json` wherever that can be helped.
 *
 * `data.json` sits inside the vault, and a vault is routinely carried by other
 * sync services, backed up to git remotes, or shared. Obsidian 1.11.4 added
 * `app.secretStorage`, which keeps a value per vault outside the vault folder,
 * and on a version that has it the tokens live there and `data.json` is written
 * without them. On an older version there is nowhere else, so the tokens stay in
 * `data.json` as before and the settings screen keeps warning about it — raising
 * the minimum version instead would cut those users off the plugin entirely.
 *
 * ─── Moving tokens an earlier version wrote ─────────────────────────────────
 * Tokens found in `data.json` on a version with secret storage are written
 * there, read back, and only then removed from `data.json`. A write that does
 * not read back leaves them where they were, so a failed move costs nothing.
 *
 * Secret storage has no delete. Signing out overwrites the value with the empty
 * string, which reads back as "no tokens".
 *
 * Should a write ever fail to read back, a new sign-in is kept in `data.json`
 * for the rest of the session rather than lost, and the settings screen goes
 * back to warning about it. A sign-out that cannot clear the secret is an
 * error, since the tokens would come back on the next start.
 */
import { t } from './i18n';
import { type SlWikiSettings, type StoredTokens, DEFAULT_SETTINGS, readTokens } from './settings';

/**
 * The secret's id. Secret storage is shared by every plugin in the vault, so the
 * id carries this plugin's own; the API takes lowercase letters, digits and
 * dashes only.
 */
export const SECRET_ID = 'slwiki-sync-tokens';

/** The two calls this module makes on `app.secretStorage`. */
export type SecretStore = {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
};

export class TokenStore {
  /**
   * The value last written to or read from secret storage, to skip rewriting
   * it; undefined while that is not known.
   */
  private written: string | null | undefined = undefined;

  /** Whether the settings last loaded or saved held tokens. */
  private held = false;

  /** Set when secret storage did not keep a write, so the tokens stay in `data.json`. */
  private failed = false;

  constructor(private readonly secrets: SecretStore | null) {}

  /** Whether the tokens are kept outside `data.json`. */
  get secure(): boolean {
    return this.secrets !== null && !this.failed;
  }

  /**
   * The settings as they should be in memory, from what `loadData` returned.
   *
   * `rewrite` is true when `data.json` still holds tokens that no longer belong
   * there — moved to secret storage, or not tokens at all — and should be saved
   * again without them. Tokens an earlier version stored without an issuer are
   * moved like any others; they stay unused until `AuthClient.adoptLegacy`
   * gives them one.
   */
  load(raw: unknown): { settings: SlWikiSettings; rewrite: boolean } {
    const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const settings: SlWikiSettings = { ...DEFAULT_SETTINGS, ...data, tokens: null } as SlWikiSettings;
    if (typeof settings.adoptFolders !== 'object' || settings.adoptFolders === null) {
      settings.adoptFolders = {};
    }
    const inData = data.tokens !== undefined && data.tokens !== null;
    const legacy = readTokens(data.tokens);

    if (this.secrets === null) {
      settings.tokens = legacy;
      this.held = legacy !== null;
      // Something that is not tokens is dropped from the file; tokens stay,
      // there being nowhere else to keep them.
      return { settings, rewrite: inData && legacy === null };
    }

    if (!inData || legacy === null) {
      // Nothing worth moving. Whatever secret storage holds is what counts.
      settings.tokens = this.readSecret();
      this.held = settings.tokens !== null;
      return { settings, rewrite: inData };
    }

    settings.tokens = legacy;
    this.held = true;
    // Moved only once the copy is known to be there; until then `data.json`
    // keeps the only copy, and the next load tries again.
    const moved = this.writeSecret(legacy);
    this.failed = !moved;
    return { settings, rewrite: moved };
  }

  /**
   * What `saveData` should be given: the settings, without the tokens when they
   * are kept in secret storage.
   */
  persist(settings: SlWikiSettings): SlWikiSettings {
    if (this.secrets === null) return settings;
    // Tokens that were there a moment ago and are not now: a sign-out, or a
    // refresh token Cognito refused. That is the one save allowed to fail on
    // secret storage, because the tokens would come back on the next start.
    const clearing = settings.tokens === null && this.held;
    this.held = settings.tokens !== null;
    if (this.writeSecret(settings.tokens)) {
      this.failed = false;
      return { ...settings, tokens: null };
    }
    if (settings.tokens === null) {
      if (clearing) throw new Error(t.secretSaveFailed);
      // An ordinary save while signed out. The clear is tried again on the
      // next one, and the settings themselves are saved regardless.
      return settings;
    }
    this.failed = true;
    return settings;
  }

  private readSecret(): StoredTokens | null {
    if (this.secrets === null) return null;
    const value = this.secrets.getSecret(SECRET_ID);
    this.written = value;
    if (value === null || value === '') return null;
    try {
      return readTokens(JSON.parse(value));
    } catch {
      return null;
    }
  }

  /** Write the tokens (or clear them) and say whether the value reads back. */
  private writeSecret(tokens: StoredTokens | null): boolean {
    if (this.secrets === null) return false;
    const value = tokens === null ? '' : JSON.stringify(tokens);
    // The settings are saved on every keystroke in a text field; the secret is
    // only rewritten when it actually changed. No secret and an empty one both
    // mean "no tokens".
    if (value === this.written || (value === '' && this.written === null)) return true;
    try {
      this.secrets.setSecret(SECRET_ID, value);
      const back = this.secrets.getSecret(SECRET_ID);
      const ok = back === value || (value === '' && back === null);
      this.written = ok ? value : undefined;
      return ok;
    } catch {
      this.written = undefined;
      return false;
    }
  }
}

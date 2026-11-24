/**
 * The external identity providers one deployment asks for, read from the
 * config file `sso.config.json` in exactly one place.
 *
 * Three readers need the same answer and must not disagree: `index.cdk.ts`
 * registers the IdPs on the pool at synth, `scripts/sso-resolve.ts` stores
 * each federation client's credentials after the deploy, and `federation.ts`
 * declares the runtime sign-in providers. The first two read the parsed
 * entries below. The runtime cannot — the file lives in the repository, not
 * in Lambda — so synth serialises the part the runtime needs (names and
 * labels, never credentials) into the single variable `SSO_PROVIDERS`, which
 * `index.cdk.ts` forwards into the Lambda's environment.
 *
 * The file replaces the per-deploy `SSO_IDP_*` environment variables
 * (ADR-0032): the entries are recorded where a fresh clone finds them, and
 * "forgot to pass one this time" stopped being a possible mistake. The file
 * is tracked but never published — it carries real issuer URLs and client
 * ids, which is why it must not appear in `scripts/public-allow.txt`. The
 * IdP client secrets stay in Secrets Manager and never enter the file.
 *
 * The first entry plays the part the unnumbered `SSO_IDP_*` block used to:
 * its CDK logical ids, secret name and SSM parameter names predate multi-IdP
 * support and are kept for ever — renaming them would make CloudFormation
 * replace the registration under a running deployment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/** One configured external IdP, with everything synth and deploy need. */
export interface SsoIdpEntry {
  /**
   * Whether this is the first entry, whose CDK logical ids, secret name and
   * SSM parameter names predate multi-IdP support and are kept for ever.
   */
  primary: boolean;
  /**
   * The name Cognito registers the IdP under. It prefixes every federated
   * username (`<name>_<sub>`), so changing it orphans those accounts.
   */
  registrationName: string;
  /**
   * The name the runtime knows the provider by: the sign-in path segment, the
   * `identityProvider` on directory records, and the `provider` half of a
   * role group's `idpGroups` entries.
   */
  providerName: string;
  /** What the sign-in button says. Defaults to the provider name. */
  label: string;
  /** The IdP's OIDC issuer URL. */
  issuerUrl: string;
  /** The client id the IdP issued. */
  clientId: string;
  /** The IdP-side claim carrying the user's groups. */
  groupsClaim: string;
  /** The scopes the pool requests from the IdP. */
  scopes: string[];
  /** An explicit Secrets Manager secret name, when the default is not used. */
  secretNameOverride: string | undefined;
}

/** What the runtime is told about one provider. Names only, never secrets. */
export interface RuntimeSsoProvider {
  name: string;
  label: string;
  primary: boolean;
}

/** The validated content of `sso.config.json`. */
export interface SsoConfig {
  /** Every configured entry, in sign-in-button order. */
  entries: SsoIdpEntry[];
  /** Origins the pool may redirect back to, besides the resolved one. */
  callbackOrigins: string[];
  /** Whether sandbox runs pick the entries up too. */
  sandbox: boolean;
}

export const SSO_CONFIG_FILE = 'sso.config.json';

/** More would need a pagination-aware `ListIdentityProviders` in the guard. */
const MAX_ENTRIES = 9;

const ssoFileSchema = z.object({
  idps: z
    .array(
      z.object({
        name: z.string().min(1),
        issuerUrl: z.string().min(1),
        clientId: z.string().min(1),
        label: z.string().min(1).optional(),
        registrationName: z.string().min(1).optional(),
        groupsClaim: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        secretName: z.string().min(1).optional(),
      }),
    )
    .max(MAX_ENTRIES),
  callbackOrigins: z.array(z.string().min(1)).optional(),
  sandbox: z.boolean().optional(),
});

/**
 * Validates one raw config object into entries. Pure — the file reading sits
 * in `loadSsoConfig` — so tests exercise every rule without touching disk.
 */
export function parseSsoConfig(raw: unknown): SsoConfig {
  const file = ssoFileSchema.parse(raw);
  const entries = file.idps.map((idp, position): SsoIdpEntry => {
    const providerName = idp.name.toLowerCase();
    const registrationName = idp.registrationName ?? providerName;
    for (const name of new Set([registrationName, providerName])) {
      // "true" is reserved because `SSO_REMOVE=true` means "remove
      // everything": a provider named `true` could never be removed
      // individually.
      if (
        !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name) ||
        ['cognito', 'true'].includes(name.toLowerCase())
      ) {
        throw new Error(
          `"${name}" cannot name an identity provider. Names are URL path segments and Cognito ` +
            'provider names: letters, digits, ".", "_" or "-", at most 32 characters, and not ' +
            'the reserved "COGNITO" or "true" (the remove-everything spelling of SSO_REMOVE).',
        );
      }
    }
    return {
      primary: position === 0,
      registrationName,
      providerName,
      label: idp.label ?? providerName,
      issuerUrl: idp.issuerUrl.replace(/\/+$/, ''),
      clientId: idp.clientId,
      groupsClaim: idp.groupsClaim ?? 'groups',
      scopes: idp.scopes ?? ['openid', 'email', 'profile'],
      secretNameOverride: idp.secretName,
    };
  });

  const seen = new Set<string>();
  for (const entry of entries) {
    for (const name of new Set([entry.registrationName.toLowerCase(), entry.providerName])) {
      if (seen.has(name)) {
        throw new Error(`Two ${SSO_CONFIG_FILE} entries share the name "${name}". Names are identity.`);
      }
      seen.add(name);
    }
  }

  // Names that differ only in punctuation (`one.login` / `one-login`) collapse
  // to one logical-id suffix, and CDK would refuse the synth with an error
  // that names neither of them — so name the clash here.
  const suffixHolders = new Map<string, string>();
  for (const entry of entries) {
    const suffix = ssoLogicalSuffix(entry);
    if (suffix === '') continue;
    const holder = suffixHolders.get(suffix);
    if (holder !== undefined) {
      throw new Error(
        `The ${SSO_CONFIG_FILE} names "${holder}" and "${entry.providerName}" both shorten to ` +
          `the logical-id suffix "${suffix}", so CloudFormation could not tell their resources ` +
          'apart. Make the names differ in letters or digits, not only punctuation.',
      );
    }
    suffixHolders.set(suffix, entry.providerName);
  }

  return {
    entries,
    callbackOrigins: (file.callbackOrigins ?? []).map((origin) => origin.replace(/\/+$/, '')),
    sandbox: file.sandbox ?? true,
  };
}

// The file is read from the working directory: every caller — the pnpm
// scripts and the synth they start — runs from the repository root, and the
// Lambda never calls this (its view of the providers is `SSO_PROVIDERS`).
// Memoised because one deploy asks several times and the answer cannot change
// mid-run.
let loadedConfig: SsoConfig | null | undefined;

/** The validated config, or `null` when the file does not exist (no SSO). */
export function loadSsoConfig(): SsoConfig | null {
  if (loadedConfig !== undefined) return loadedConfig;
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), SSO_CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      loadedConfig = null;
      return loadedConfig;
    }
    throw error;
  }
  try {
    loadedConfig = parseSsoConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `${SSO_CONFIG_FILE} is not a valid SSO config: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return loadedConfig;
}

/**
 * Every configured entry, in button order, or `[]` when there is no config
 * file, no entries, or the caller is a sandbox run the file opted out of
 * (`"sandbox": false`).
 */
export function ssoIdpEntries(options?: { sandbox?: boolean }): SsoIdpEntry[] {
  const config = loadSsoConfig();
  if (config === null) return [];
  if (options?.sandbox === true && !config.sandbox) return [];
  return config.entries;
}

/** The configured extra callback origins (the file's `callbackOrigins`). */
export function ssoCallbackOriginsFromConfig(): string[] {
  return loadSsoConfig()?.callbackOrigins ?? [];
}

/**
 * The Secrets Manager secret CloudFormation reads this entry's IdP client
 * secret from. The primary entry keeps the pre-multi-IdP name, so the secret
 * a running deployment already holds goes on being read.
 */
export function ssoSecretName(entry: SsoIdpEntry, stackName: string): string {
  if (entry.secretNameOverride !== undefined) return entry.secretNameOverride;
  return entry.primary
    ? `${stackName}-sl-wiki-sso-idp-client-secret`
    : `${stackName}-sl-wiki-sso-idp-${entry.providerName}-client-secret`;
}

/**
 * The `AppSetting` ids holding this entry's federation-client credentials —
 * the pool-side app client's, not the IdP's. The primary entry keeps the
 * pre-multi-IdP ids for the same reason its secret name never changes.
 */
export function ssoSettingIds(provider: { name: string; primary: boolean }): {
  clientId: string;
  clientSecret: string;
} {
  return provider.primary
    ? { clientId: 'sso-client-id', clientSecret: 'sso-client-secret' }
    : { clientId: `sso-client-id-${provider.name}`, clientSecret: `sso-client-secret-${provider.name}` };
}

/**
 * The suffix a per-entry CDK logical id and stack output carry. Empty for the
 * primary entry (whose ids predate multi-IdP support), the PascalCased name
 * for the rest — keyed on the name, not the position, so reordering entries
 * never moves a resource.
 */
export function ssoLogicalSuffix(entry: SsoIdpEntry): string {
  if (entry.primary) return '';
  return entry.providerName
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

/** The serialised form synth hands the runtime through `SSO_PROVIDERS`. */
export function ssoProvidersJson(entries: SsoIdpEntry[]): string {
  return JSON.stringify(
    entries.map(
      (entry): RuntimeSsoProvider => ({
        name: entry.providerName,
        label: entry.label,
        primary: entry.primary,
      }),
    ),
  );
}

/**
 * The providers the runtime offers, from `SSO_PROVIDERS`.
 *
 * The fallback covers an environment where the issuer is configured but the
 * list is not — a Lambda deployed before the variable existed, or a shell
 * that set `SSO_ISSUER_URL` by hand — and reproduces the single-IdP shape
 * those environments were built for. Parsing is strict: the value is written
 * by synth, never by hand, so a malformed one is corruption worth stopping on.
 */
export function runtimeSsoProviders(): RuntimeSsoProvider[] {
  const raw = (process.env.SSO_PROVIDERS ?? '').trim();
  if (raw === '') {
    if ((process.env.SSO_ISSUER_URL ?? '').trim() === '') return [];
    return [{ name: 'sso', label: 'sso', primary: true }];
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry): entry is RuntimeSsoProvider =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RuntimeSsoProvider).name === 'string' &&
        typeof (entry as RuntimeSsoProvider).label === 'string' &&
        typeof (entry as RuntimeSsoProvider).primary === 'boolean',
    )
  ) {
    throw new Error('SSO_PROVIDERS is not the list synth writes. Redeploy rather than hand-edit.');
  }
  return parsed;
}

/**
 * Which callers may reach the Wiki's front door at all, read from the config
 * file `entry-guard.config.json` in exactly one place.
 *
 * The guard narrows reach, not access: everything behind it still requires a
 * signed-in user and the per-space permission checks. What it adds is that
 * the CloudFront front door answers only callers from the allowed countries,
 * plus Anthropic's published outbound ranges on the MCP paths (so claude.ai
 * connectors keep working), and that the API Gateway stage refuses any call
 * that did not come through CloudFront.
 *
 * The file is tracked but never published: the countries one operator allows
 * and whether they use claude.ai are that operator's policy, and a public
 * clone must get no guard unless it asks for one. With no file, nothing is
 * created. It must therefore never appear in `scripts/public-allow.txt`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

export const ENTRY_GUARD_CONFIG_FILE = 'entry-guard.config.json';

/**
 * Anthropic's published outbound IPv4 ranges — where requests from claude.ai
 * connectors (MCP tool calls to external servers) come from. Public
 * information, documented "will not change without notice" at
 * https://platform.claude.com/docs/en/api/ip-addresses ; the config file can
 * replace the list (`claudeAi.sourceRanges`) the day it does change.
 */
export const ANTHROPIC_OUTBOUND_RANGES: readonly string[] = ['160.79.104.0/21', '153.61.208.0/20'];

/**
 * The paths a claude.ai connector calls on this origin: the MCP endpoint and
 * the three OAuth discovery documents (RFC 9728 and RFC 8414). The token
 * endpoint is on the Cognito hosted domain, which is not behind CloudFront.
 */
export const MCP_PATHS: readonly string[] = [
  '/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
];

/** Requests one source IP may make in five minutes before it is limited. */
export const DEFAULT_RATE_LIMIT = 1000;

const ipv4Cidr = z
  .string()
  .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/, 'an IPv4 CIDR such as 160.79.104.0/21')
  .refine((cidr) => {
    const [address, bits] = cidr.split('/') as [string, string];
    return address.split('.').every((octet) => Number(octet) <= 255) && Number(bits) <= 32;
  }, 'octets must be 0–255 and the prefix 0–32');

const entryGuardFileSchema = z
  .object({
    mode: z.enum(['count', 'block']),
    allowCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code in capitals, such as JP'))
      .min(1),
    claudeAi: z
      .object({
        enabled: z.boolean(),
        sourceRanges: z.array(ipv4Cidr).min(1).optional(),
      })
      .strict()
      .optional(),
    rateLimit: z.number().int().min(10).max(2_000_000_000).optional(),
    originSecret: z
      .object({
        generation: z.number().int().min(0),
        acceptPrevious: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The validated content of `entry-guard.config.json`. */
export interface EntryGuardConfig {
  /**
   * `count` records what the guard would refuse without refusing it, and
   * leaves the API stage open to direct calls; `block` refuses.
   */
  mode: 'count' | 'block';
  /** Countries whose callers reach every path. */
  allowCountries: string[];
  /** Source ranges allowed on {@link MCP_PATHS} from anywhere; empty when claude.ai is off. */
  claudeAiRanges: string[];
  /** Per-IP limit over five minutes. */
  rateLimit: number;
  /**
   * Which origin-verify secret is current. Raising it creates a new secret;
   * with `acceptPrevious`, the stage also keeps accepting the previous one for
   * the deploy in which CloudFront's edges move over. Raise it by exactly one:
   * only generation - 1 is kept, so skipping a number refuses every request
   * until the edges have the new value.
   */
  originSecret: { generation: number; acceptPrevious: boolean };
}

/**
 * Validates one raw config object. Pure — the file reading sits in
 * `loadEntryGuardConfig` — so tests exercise every rule without touching disk.
 */
export function parseEntryGuardConfig(raw: unknown): EntryGuardConfig {
  const file = entryGuardFileSchema.parse(raw);
  const claudeAi = file.claudeAi ?? { enabled: false };
  const generation = file.originSecret?.generation ?? 0;
  const acceptPrevious = file.originSecret?.acceptPrevious ?? false;
  if (acceptPrevious && generation === 0) {
    throw new Error(
      'originSecret.acceptPrevious needs a previous secret to accept, so it only makes sense ' +
        'with a generation above 0.',
    );
  }
  return {
    mode: file.mode,
    allowCountries: [...new Set(file.allowCountries)],
    claudeAiRanges: claudeAi.enabled
      ? [...(claudeAi.sourceRanges ?? ANTHROPIC_OUTBOUND_RANGES)]
      : [],
    rateLimit: file.rateLimit ?? DEFAULT_RATE_LIMIT,
    originSecret: { generation, acceptPrevious },
  };
}

/**
 * The validated config, or `null` when the file does not exist (no guard).
 * Read from the working directory: the pnpm scripts and the synth they start
 * all run from the repository root.
 */
export function loadEntryGuardConfig(): EntryGuardConfig | null {
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), ENTRY_GUARD_CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return parseEntryGuardConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `${ENTRY_GUARD_CONFIG_FILE} is not a valid entry guard config: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

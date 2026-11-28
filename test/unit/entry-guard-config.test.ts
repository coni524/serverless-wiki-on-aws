/**
 * Parsing of `entry-guard.config.json`. `parseEntryGuardConfig` is pure, so
 * every rule is exercised on plain objects with no file on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  ANTHROPIC_OUTBOUND_RANGES,
  DEFAULT_RATE_LIMIT,
  parseEntryGuardConfig,
} from '../../cdk-blocks/entry-guard-config.js';

test('a minimal file allows the listed countries only, with the defaults', () => {
  const config = parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP'] });
  assert.deepStrictEqual(config, {
    mode: 'count',
    allowCountries: ['JP'],
    claudeAiRanges: [],
    rateLimit: DEFAULT_RATE_LIMIT,
    originSecret: { generation: 0, acceptPrevious: false },
  });
});

test("claude.ai on uses Anthropic's published ranges unless the file names others", () => {
  const published = parseEntryGuardConfig({
    mode: 'block',
    allowCountries: ['JP'],
    claudeAi: { enabled: true },
  });
  assert.deepStrictEqual(published.claudeAiRanges, [...ANTHROPIC_OUTBOUND_RANGES]);

  const replaced = parseEntryGuardConfig({
    mode: 'block',
    allowCountries: ['JP'],
    claudeAi: { enabled: true, sourceRanges: ['203.0.113.0/24'] },
  });
  assert.deepStrictEqual(replaced.claudeAiRanges, ['203.0.113.0/24']);
});

test('claude.ai off ignores any ranges', () => {
  const config = parseEntryGuardConfig({
    mode: 'block',
    allowCountries: ['JP'],
    claudeAi: { enabled: false, sourceRanges: ['203.0.113.0/24'] },
  });
  assert.deepStrictEqual(config.claudeAiRanges, []);
});

test('duplicate countries collapse', () => {
  const config = parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP', 'US', 'JP'] });
  assert.deepStrictEqual(config.allowCountries, ['JP', 'US']);
});

test('refuses what would build a wrong or empty guard', () => {
  const refused: unknown[] = [
    {},
    { mode: 'count' },
    { mode: 'count', allowCountries: [] },
    { mode: 'count', allowCountries: ['jp'] },
    { mode: 'count', allowCountries: ['JPN'] },
    { mode: 'deny', allowCountries: ['JP'] },
    { mode: 'count', allowCountries: ['JP'], claudeAi: { enabled: true, sourceRanges: ['160.79.104.0'] } },
    { mode: 'count', allowCountries: ['JP'], claudeAi: { enabled: true, sourceRanges: ['300.1.1.0/24'] } },
    { mode: 'count', allowCountries: ['JP'], claudeAi: { enabled: true, sourceRanges: ['2607:6bc0::/48'] } },
    { mode: 'count', allowCountries: ['JP'], claudeAi: { enabled: true, sourceRanges: [] } },
    { mode: 'count', allowCountries: ['JP'], rateLimit: 5 },
    { mode: 'count', allowCountries: ['JP'], unknown: true },
    { mode: 'count', allowCountries: ['JP'], originSecret: { generation: -1 } },
    // Nothing to accept before the first generation.
    { mode: 'count', allowCountries: ['JP'], originSecret: { generation: 0, acceptPrevious: true } },
  ];
  for (const raw of refused) {
    assert.throws(() => parseEntryGuardConfig(raw), Error, JSON.stringify(raw));
  }
});

test('a rotation keeps the previous secret only when asked to', () => {
  const config = parseEntryGuardConfig({
    mode: 'block',
    allowCountries: ['JP'],
    originSecret: { generation: 2, acceptPrevious: true },
  });
  assert.deepStrictEqual(config.originSecret, { generation: 2, acceptPrevious: true });
});

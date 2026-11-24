/**
 * Unit tests for the excerpt builder: phrase extraction, the normalization
 * map back into the original text, window placement, and highlight offsets.
 * The index read around it is thin I/O, exercised through the dev server.
 *
 * Run with: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { excerptOf, queryPhrases } from '../../cdk-blocks/search-excerpt.js';

/** The emphasized substrings, in order — what a reader would see in bold. */
const emphasized = (text: string, query: string): string[] => {
  const { snippet, highlights } = excerptOf(text, query);
  return highlights.map(([start, end]) => snippet.slice(start, end));
};

// ─── queryPhrases ────────────────────────────────────────────────────────────

test('runs stay whole phrases, split at the script boundary', () => {
  assert.deepEqual(queryPhrases('東京タワー AWS'), ['東京タワー', 'aws']);
  assert.deepEqual(queryPhrases('abc東京'), ['abc', '東京']);
});

test('duplicate phrases collapse and punctuation separates runs', () => {
  assert.deepEqual(queryPhrases('aws、aws'), ['aws']);
});

test('a single character is a phrase, since the analyzer can match it', () => {
  assert.deepEqual(queryPhrases('猫 東京'), ['猫', '東京']);
  assert.deepEqual(queryPhrases('a'), ['a']);
});

// ─── excerptOf ───────────────────────────────────────────────────────────────

test('a hit is emboldened where the phrase occurs', () => {
  const { snippet, highlights } = excerptOf('EventBridge のルールを止める', 'eventbridge');
  assert.equal(snippet, 'EventBridge のルールを止める');
  assert.deepEqual(highlights, [[0, 'EventBridge'.length]]);
});

test('matching is case- and width-insensitive but the original text is shown', () => {
  assert.deepEqual(emphasized('ＡＷＳ Ｌａｍｂｄａ の話', 'aws lambda'), ['ＡＷＳ', 'Ｌａｍｂｄａ']);
});

test('half-width katakana with sound marks matches its composed form', () => {
  assert.deepEqual(emphasized('ﾃﾞｰﾀﾍﾞｰｽの設定', 'データベース'), ['ﾃﾞｰﾀﾍﾞｰｽ']);
});

test('every occurrence inside the window is emphasized', () => {
  assert.deepEqual(emphasized('kafka を kafka で監視する', 'kafka'), ['kafka', 'kafka']);
});

test('a long text is windowed around the first hit, with ellipses at the cuts', () => {
  const text = `${'あ'.repeat(300)}目印${'い'.repeat(300)}`;
  const { snippet, highlights } = excerptOf(text, '目印');
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.length < 220);
  assert.deepEqual(
    highlights.map(([start, end]) => snippet.slice(start, end)),
    ['目印'],
  );
});

test('text before the window head is not cut when the hit is early', () => {
  const { snippet } = excerptOf('目印のあとに続く本文', '目印');
  assert.ok(!snippet.startsWith('…'));
});

test('whitespace runs collapse without shifting the highlight offsets', () => {
  assert.deepEqual(emphasized('前の行\n\n  kafka  \nあとの行', 'kafka'), ['kafka']);
});

test('no phrase found falls back to the head of the text with no highlights', () => {
  const { snippet, highlights } = excerptOf('関係のない本文がここにある', 'kafka');
  assert.equal(highlights.length, 0);
  assert.ok(snippet.startsWith('関係のない'));
});

test('a single-character query is emboldened where it occurs', () => {
  assert.deepEqual(emphasized('ネコ（猫）は食肉目', '猫'), ['猫']);
});

test('overlapping phrase occurrences merge into one range', () => {
  // Query phrases 東京 and 京都 overlap nowhere, but 東京 and 東京タワー do.
  assert.deepEqual(emphasized('東京タワーの案内', '東京タワー 東京'), ['東京タワー']);
});

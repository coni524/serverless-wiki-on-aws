/**
 * Unit tests for the pure parts of the keyword index: tokenization, index
 * construction, and BM25 evaluation. Storage and the rebuild job are exercised
 * through the dev server instead — they are thin I/O around these functions.
 *
 * Run with: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildIndex,
  parseIndex,
  searchIndex,
  searchTitlePrefix,
  titleOfCorpus,
  tokenize,
} from '../../aws-blocks/keyword-index.js';

// ─── tokenize ────────────────────────────────────────────────────────────────

test('ASCII runs stay whole words, lowercased', () => {
  assert.deepEqual(tokenize('AWS Lambda'), ['aws', 'lambda']);
});

test('full-width alphanumerics normalize onto their ASCII terms', () => {
  assert.deepEqual(tokenize('ＡＷＳ Ｌａｍｂｄａ'), ['aws', 'lambda']);
});

test('Japanese runs become overlapping bigrams', () => {
  assert.deepEqual(tokenize('東京タワー'), ['東京', '京タ', 'タワ', 'ワー']);
});

test('punctuation breaks a run, so bigrams never straddle it', () => {
  assert.deepEqual(tokenize('東京、タワー'), ['東京', 'タワ', 'ワー']);
});

test('ASCII and Japanese runs split at their boundary', () => {
  assert.deepEqual(tokenize('abc東京def'), ['abc', '東京', 'def']);
});

test('a single non-ASCII character yields no term', () => {
  assert.deepEqual(tokenize('犬'), []);
});

test('a single ASCII character is a term of its own', () => {
  assert.deepEqual(tokenize('a'), ['a']);
});

test('half-width katakana composes with its sound mark under NFKC', () => {
  // ｶﾞｷﾞ → ガギ (two precomposed characters, one bigram)
  assert.deepEqual(tokenize('ｶﾞｷﾞ'), ['ガギ']);
});

// ─── build / parse / search ──────────────────────────────────────────────────

const roundTrip = (documents: { pageId: string; text: string; title?: string }[]) =>
  parseIndex(JSON.stringify(buildIndex(documents)));

test('a term found in one document returns exactly that document', () => {
  const index = roundTrip([
    { pageId: 'p1', text: '# 運用手順\n\nEventBridge のルールを止める' },
    { pageId: 'p2', text: '# 議事録\n\n来期の予算について' },
  ]);
  assert.deepEqual(
    searchIndex(index, 'eventbridge', 10).map((hit) => hit.pageId),
    ['p1'],
  );
});

test('every query term must match — AND semantics', () => {
  const index = roundTrip([
    { pageId: 'p1', text: 'alpha beta' },
    { pageId: 'p2', text: 'alpha gamma' },
  ]);
  assert.deepEqual(
    searchIndex(index, 'alpha beta', 10).map((hit) => hit.pageId),
    ['p1'],
  );
});

test('a term nobody contains returns nothing, even alongside a common one', () => {
  const index = roundTrip([{ pageId: 'p1', text: 'alpha beta' }]);
  assert.deepEqual(searchIndex(index, 'alpha zeta', 10), []);
});

test('Japanese query matches through its bigrams', () => {
  const index = roundTrip([
    { pageId: 'p1', text: '東京タワーの案内' },
    { pageId: 'p2', text: '京都タワーの案内' },
  ]);
  // 東京 + 京タ + タワ + ワー all appear only in p1 (p2 lacks 東京 and 京タ).
  assert.deepEqual(
    searchIndex(index, '東京タワー', 10).map((hit) => hit.pageId),
    ['p1'],
  );
});

test('BM25 ranks the document where the term is denser first', () => {
  const index = roundTrip([
    { pageId: 'sparse', text: 'kafka ' + 'filler '.repeat(50) },
    { pageId: 'dense', text: 'kafka kafka kafka' },
  ]);
  assert.deepEqual(
    searchIndex(index, 'kafka', 10).map((hit) => hit.pageId),
    ['dense', 'sparse'],
  );
});

test('limit caps the hits after ranking', () => {
  const index = roundTrip([
    { pageId: 'p1', text: 'kafka kafka' },
    { pageId: 'p2', text: 'kafka' },
    { pageId: 'p3', text: 'kafka kafka kafka' },
  ]);
  assert.equal(searchIndex(index, 'kafka', 2).length, 2);
});

test('terms that collide with Object.prototype are looked up safely', () => {
  const index = roundTrip([{ pageId: 'p1', text: 'the constructor pattern' }]);
  assert.deepEqual(
    searchIndex(index, 'constructor', 10).map((hit) => hit.pageId),
    ['p1'],
  );
  assert.deepEqual(searchIndex(index, 'hasOwnProperty', 10), []);
});

test('an index of an unknown version is refused rather than misread', () => {
  assert.throws(() => parseIndex(JSON.stringify({ version: 3, docs: [], postings: {} })));
});

test('an index written before titles rode along still reads, without them', () => {
  // Version 1 documents are `[pageId, term count]`; the title is simply absent.
  const index = parseIndex(
    JSON.stringify({ version: 1, docs: [['p1', 2]], postings: { alpha: [0, 1] } }),
  );
  assert.deepEqual(
    searchIndex(index, 'alpha', 10).map((hit) => hit.pageId),
    ['p1'],
  );
  assert.deepEqual(searchTitlePrefix(index, 'a', 10), []);
});

// ─── titles ──────────────────────────────────────────────────────────────────

test('the title is read from the corpus document’s leading heading', () => {
  assert.equal(titleOfCorpus('# 運用手順\n\n本文'), '運用手順');
  assert.equal(titleOfCorpus('見出しのない本文'), '');
  assert.equal(titleOfCorpus('# 一行だけ'), '一行だけ');
});

test('a title prefix matches what the inverted index cannot: one character', () => {
  const index = roundTrip([
    { pageId: 'p1', text: '# 犬の飼い方\n\n本文', title: '犬の飼い方' },
    { pageId: 'p2', text: '# ネコ\n\n本文', title: 'ネコ' },
  ]);
  // 「犬」 makes no bigram, so the body search cannot see it at all.
  assert.deepEqual(searchIndex(index, '犬', 10), []);
  assert.deepEqual(
    searchTitlePrefix(index, '犬', 10).map((hit) => hit.pageId),
    ['p1'],
  );
});

test('title matching ignores case and width, and shorter titles come first', () => {
  const index = roundTrip([
    { pageId: 'long', text: '# AWS Lambda の運用\n\n本文', title: 'AWS Lambda の運用' },
    { pageId: 'short', text: '# AWS\n\n本文', title: 'AWS' },
  ]);
  assert.deepEqual(
    searchTitlePrefix(index, 'ａｗｓ', 10).map((hit) => hit.pageId),
    ['short', 'long'],
  );
});

test('a prefix is a prefix: a title matching in the middle is not offered', () => {
  const index = roundTrip([
    { pageId: 'p1', text: '# 運用手順\n\n本文', title: '運用手順' },
  ]);
  assert.deepEqual(searchTitlePrefix(index, '手順', 10), []);
});

test('an empty query or an empty index returns nothing', () => {
  const index = roundTrip([{ pageId: 'p1', text: 'alpha' }]);
  assert.deepEqual(searchIndex(index, '、。', 10), []);
  assert.deepEqual(searchIndex(roundTrip([]), 'alpha', 10), []);
});

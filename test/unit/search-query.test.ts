/**
 * Unit tests for how a search request prepares its query before the index and
 * the excerpts see it: trimmed, cut to the index's limit, and split into
 * phrases once.
 *
 * Run with: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { excerptOf, queryPhrases } from '../../cdk-blocks/search-excerpt.js';
import { MAX_QUERY_CHARS } from '../../cdk-blocks/search-index.js';
import { hitLimit, searchQuerySchema, searchTerms } from '../../cdk-blocks/wiki-ops.js';

/** The emphasized substrings, in order — what a reader would see in bold. */
const emphasized = (text: string, phrases: string[]): string[] => {
  const { snippet, highlights } = excerptOf(text, phrases);
  return highlights.map(([start, end]) => snippet.slice(start, end));
};

test('a normal query passes through trimmed and split as before', () => {
  const { text, phrases } = searchTerms('  東京タワー AWS  ');
  assert.equal(text, '東京タワー AWS');
  assert.deepEqual(phrases, queryPhrases('東京タワー AWS'));
  assert.deepEqual(emphasized('AWS で東京タワーを照らす', phrases), ['AWS', '東京タワー']);
});

test('a query at the limit is kept whole', () => {
  const query = `${'あ'.repeat(MAX_QUERY_CHARS - 6)} kafka`;
  assert.equal(query.length, MAX_QUERY_CHARS);
  const { text, phrases } = searchTerms(query);
  assert.equal(text, query);
  assert.ok(phrases.includes('kafka'));
});

test('an over-long query is cut to the index limit before any excerpt is built', () => {
  // The head names a word the page holds; the tail is hundreds of thousands
  // of distinct words, one of which also occurs in the page. Only the head
  // may reach the excerpt, exactly as only the head reaches the index.
  const head = `kafka ${'x'.repeat(MAX_QUERY_CHARS)}`;
  const tail = Array.from({ length: 300_000 }, (_, i) => `e${i}`).join(' ');
  const query = `${head} lambda ${tail}`;
  assert.ok(query.length > 1_000_000);

  const { text, phrases } = searchTerms(query);
  assert.equal(text.length, MAX_QUERY_CHARS);
  assert.ok(query.startsWith(text));
  assert.ok(phrases.length <= MAX_QUERY_CHARS);
  assert.ok(!phrases.includes('lambda'), 'A word past the limit must not be searched for');
  assert.ok(!phrases.includes('e0'));

  assert.deepEqual(emphasized('kafka と lambda の連携', phrases), ['kafka']);
});

test('a query of only whitespace is empty', () => {
  assert.deepEqual(searchTerms(' \n\t '), { text: '', phrases: [] });
});

test('a query that is not a string is refused as invalid input, not a server error', () => {
  for (const query of [123, null, undefined, { q: 'aws' }, ['aws']]) {
    assert.throws(
      () => searchTerms(query),
      (error: { status?: number; name?: string; message?: string }) =>
        error.status === 400 &&
        error.name === 'ValidationFailedException' &&
        /string/.test(error.message ?? ''),
    );
  }
});

test('the tools refuse an over-long query and accept one at the limit', () => {
  assert.equal(searchQuerySchema.safeParse('あ'.repeat(MAX_QUERY_CHARS)).success, true);
  assert.equal(searchQuerySchema.safeParse('あ'.repeat(MAX_QUERY_CHARS + 1)).success, false);
  assert.equal(searchQuerySchema.safeParse(42).success, false);
});

test('a left-out limit is the default, and a numeric one is floored and clamped', () => {
  assert.equal(hitLimit(undefined, 10, 50), 10);
  assert.equal(hitLimit(null, 10, 50), 10);
  assert.equal(hitLimit(5, 10, 50), 5);
  assert.equal(hitLimit(5.9, 10, 50), 5);
  assert.equal(hitLimit(0, 10, 50), 1);
  assert.equal(hitLimit(-3, 10, 50), 1);
  assert.equal(hitLimit(1000, 10, 50), 50);
});

test('a limit that is not a finite number is refused, so NaN never reaches the index', () => {
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', 'abc', {}, [5], true]) {
    assert.throws(
      () => hitLimit(limit, 10, 50),
      (error: { status?: number; name?: string }) =>
        error.status === 400 && error.name === 'ValidationFailedException',
      `limit ${String(limit)} must be refused`,
    );
  }
});

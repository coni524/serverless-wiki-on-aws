/**
 * Unit tests for how a page body is cut into chunks before it is embedded.
 *
 *   pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunksOf } from '../../aws-blocks/search-index.js';

test('a short body is one chunk', () => {
  assert.deepEqual(chunksOf('# 見出し\n\n本文'), ['# 見出し\n\n本文']);
});

test('an empty body is one empty chunk, so the title alone is still indexed', () => {
  assert.deepEqual(chunksOf(''), ['']);
});

test('chunks break at paragraphs and stay within 4,000 characters', () => {
  const paragraph = 'あ'.repeat(1500);
  const chunks = chunksOf([paragraph, paragraph, paragraph].join('\n\n'));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${paragraph}\n\n${paragraph}`);
  assert.equal(chunks[1], paragraph);
});

test('a paragraph longer than a chunk is cut at the limit', () => {
  const chunks = chunksOf('い'.repeat(9000));
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [4000, 4000, 1000],
  );
});

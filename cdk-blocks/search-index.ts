/**
 * Search index — page text in one Amazon S3 Vectors index, searched with the
 * index's own hybrid search.
 *
 * Each page is cut into chunks; each chunk is one vector, keyed
 * `<pageId>#<n>`, embedded with Titan Text Embeddings V2 and carrying four
 * metadata fields:
 *
 *   - `spaceId`, `pageId`  filterable — a single-space search filters on `spaceId`
 *   - `title`, `body`      full-text searchable with the Japanese analyzer
 *
 * One `QueryVectors` call runs the vector search and the BM25 full-text search
 * and fuses the two rankings (Reciprocal Rank Fusion) on the service side. The
 * analyzer is used as it is: it matches whole words, so "サーバ" does not find
 * "サーバー" and a word cut short finds nothing. Nothing here rewrites text to
 * paper over that — it is the analyzer's documented behavior.
 *
 * The index is a *derived* copy of the pages. Writes go through an AsyncJob
 * that reads the page as it stands when the job runs, so a job for a page that
 * has since been deleted removes its vectors instead of writing them. Jobs can
 * run concurrently (standard SQS), so a job confirms after writing that the
 * page did not change meanwhile, and goes again if it did — otherwise a slow
 * job holding an older text could land last. Leftover chunks of a page that
 * shrank are deleted over the whole possible key range, which needs no record
 * of how many chunks there were (deleting a missing key is not an error).
 *
 * Local development has no S3 Vectors. Under `pnpm dev` (no
 * `SEARCH_INDEX_ARN`) the job is not used and search falls back to a plain
 * substring match over the pages — a stand-in so the screens work offline,
 * not a model of the hybrid ranking. Try search for real on a sandbox.
 */
import { AsyncJob } from 'aws-cdk-blocks';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  DeleteVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { z } from 'zod';

import { ALL_SPACES, PAGE_SK_PREFIX, idOf, kindOf, pageSk, spacePk } from './model.js';
import { readBody } from './pages.js';
import { scope, table, valuesOf } from './resources.js';

/** The index, injected by `index.cdk.ts`. Unset means the local dev server. */
const INDEX_ARN = process.env.SEARCH_INDEX_ARN ?? '';
export const onAws = INDEX_ARN !== '';

const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
/** Must match the index's `dimension` in `index.cdk.ts`. */
export const EMBEDDING_DIMENSION = 1024;

/**
 * Longest chunk, in characters. Titan Text Embeddings V2 takes 8,192 tokens;
 * 4,000 characters stays inside that even for Japanese, and is far below the
 * 100 KB a full-text field may hold.
 */
const CHUNK_CHARS = 4000;

/**
 * More chunks than a page can ever have. A body is at most 1 MiB, and two
 * consecutive chunks always hold more than `CHUNK_CHARS - 2` characters
 * between them (otherwise they would have been packed into one), so a page
 * makes at most about 525 chunks.
 */
const MAX_CHUNKS = 600;

/** `PutVectors` and `DeleteVectors` take at most 500 vectors or keys per call. */
const BATCH = 500;

/** `QueryVectors` accepts at most 1,024 characters of query text. */
const MAX_QUERY_CHARS = 1024;

/** A metadata filter may hold at most 100 constraints; `$in` counts each value. */
const MAX_FILTER_VALUES = 100;

// Created lazily: this module is imported during CDK synth too, where a client
// would resolve credentials for nothing.
let vectorsClient: S3VectorsClient | undefined;
let bedrockClient: BedrockRuntimeClient | undefined;
const vectors = () => (vectorsClient ??= new S3VectorsClient({}));
const bedrock = () => (bedrockClient ??= new BedrockRuntimeClient({}));

const chunkKey = (pageId: string, n: number) => `${pageId}#${n}`;

// ─── Writing ─────────────────────────────────────────────────────────────────

/** Embed one text with Titan Text Embeddings V2. */
async function embed(text: string): Promise<number[]> {
  const response = await bedrock().send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSION, normalize: true }),
    }),
  );
  return (JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] }).embedding;
}

/**
 * Cut a body into chunks of at most `CHUNK_CHARS`, at paragraph breaks where
 * it can. A paragraph longer than a chunk is cut at the limit. An empty body is
 * one empty chunk, so a page with only a title is still found by its title.
 */
export function chunksOf(body: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of body.split(/\n{2,}/)) {
    for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
      const piece = paragraph.slice(i, i + CHUNK_CHARS);
      if (current !== '' && current.length + 2 + piece.length > CHUNK_CHARS) {
        chunks.push(current);
        current = piece;
      } else {
        current = current === '' ? piece : `${current}\n\n${piece}`;
      }
    }
  }
  if (current !== '' || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** Delete every chunk key from `from` up to the most a page can have. */
async function deleteChunksFrom(pageId: string, from: number): Promise<void> {
  for (let start = from; start < MAX_CHUNKS; start += BATCH) {
    const keys = [];
    for (let n = start; n < Math.min(MAX_CHUNKS, start + BATCH); n += 1) keys.push(chunkKey(pageId, n));
    await vectors().send(new DeleteVectorsCommand({ indexArn: INDEX_ARN, keys }));
  }
}

/** What a page's indexed text depends on; a change in any of these means re-sync. */
const versionOf = (item: { title?: string; bodyKey?: string; updatedAt?: string } | null) =>
  item === null ? null : JSON.stringify([item.title, item.bodyKey, item.updatedAt]);

/**
 * Bring one page's vectors in line with the page as it stands now: written if
 * it is a page, removed if it is gone or is a folder (folders have no text).
 */
export async function syncPage(spaceId: string, pageId: string): Promise<void> {
  const read = async () => {
    const item = await table.get({ pk: spacePk(spaceId), sk: pageSk(pageId) });
    return item !== null && item.type === 'PAGE' && kindOf(item) === 'page' ? item : null;
  };
  let page = await read();
  // A few rounds at most: each one only follows a save that landed meanwhile.
  for (let round = 0; round < 3; round += 1) {
    if (page === null) {
      await deleteChunksFrom(pageId, 0);
      return;
    }
    const written = await writePage({
      spaceId,
      pageId,
      title: page.title ?? '',
      body: await readBody(page.bodyKey),
    });
    await deleteChunksFrom(pageId, written);
    const now = await read();
    if (versionOf(now) === versionOf(page)) return;
    page = now;
  }
}

/**
 * Write one page's chunks and return how many there are. Exported for the
 * reindex script, which reads the pages itself; everything else goes through
 * `syncPage`.
 */
export async function writePage(page: {
  spaceId: string;
  pageId: string;
  title: string;
  body: string;
}): Promise<number> {
  const chunks = chunksOf(page.body);
  const entries = [];
  for (const [n, text] of chunks.entries()) {
    entries.push({
      key: chunkKey(page.pageId, n),
      // The title leads the embedded text: a page is often looked for by name.
      data: { float32: await embed(`${page.title}\n\n${text}`.trim()) },
      metadata: { spaceId: page.spaceId, pageId: page.pageId, title: page.title, body: text },
    });
  }
  for (let start = 0; start < entries.length; start += BATCH) {
    await vectors().send(
      new PutVectorsCommand({ indexArn: INDEX_ARN, vectors: entries.slice(start, start + BATCH) }),
    );
  }
  return chunks.length;
}

const syncPayload = z.object({ spaceId: z.string().min(1), pageId: z.string().min(1) });

/**
 * Applies one page's change to the index. One job per page; the handler reads
 * the current state and re-checks it after writing (see `syncPage`).
 */
export const searchIndexJob = new AsyncJob(scope, 'search-index', {
  schema: syncPayload,
  // Submitted on every save, so SQS should hand it over at once rather than
  // wait to fill a batch: the page should reach search within seconds.
  maxBatchingWindowSeconds: 0,
  handler: async ({ spaceId, pageId }) => {
    await syncPage(spaceId, pageId);
  },
});

/**
 * Ask for pages to be (re)indexed or removed, best-effort.
 *
 * The page is already saved when this runs, so a failure to enqueue must not
 * fail the save: the page only stays stale in search until its next edit. The
 * failure is logged with the page ids only, so a page missing from search can
 * be traced.
 */
export async function requestSync(pages: Array<{ spaceId: string; pageId: string }>): Promise<void> {
  if (!onAws || pages.length === 0) return;
  await searchIndexJob.submitBatch(pages).catch((reason: unknown) => {
    console.warn(
      '[sl-wiki] Could not request a search index update; these pages stay stale in search.',
      pages.map((page) => page.pageId),
      reason,
    );
  });
}

// ─── Searching ───────────────────────────────────────────────────────────────

/** A hit reduced to its page, in ranking order. */
export type IndexHit = {
  spaceId: string;
  pageId: string;
  /** The matching chunk's text, for the excerpt. */
  text: string;
  /** Whether the full-text search matched (as opposed to the vector search only). */
  matchedText: boolean;
};

/**
 * Hits found by the vector search alone, at a cosine distance beyond this,
 * are noise. Vector search always fills `topK` with the nearest chunks, so an
 * off-topic query still returns something. A full-text match is always kept.
 */
const MAX_VECTOR_DISTANCE = 0.4;

/**
 * Query the index. With `vector: false` only the full-text search runs —
 * that skips the Bedrock call, which is what makes it cheap enough for
 * suggestions on every keystroke.
 *
 * `spaceIds` narrows the search to those spaces before ranking, so the hits
 * are not used up by pages the caller cannot read; omitted, every space is
 * searched. Past what a filter can hold, the narrowing is dropped. Either way
 * it is a narrowing only — the caller's permission filter is the authorization.
 */
export async function queryIndex(
  query: string,
  options: { spaceIds?: string[]; topK: number; vector: boolean },
): Promise<IndexHit[]> {
  const text = query.slice(0, MAX_QUERY_CHARS);
  const spaceIds = options.spaceIds;
  if (spaceIds?.length === 0) return [];
  if (!onAws) return await searchLocally(spaceIds?.length === 1 ? spaceIds[0] : undefined, text, options.topK);

  const filter: Record<string, Record<string, string | string[]>> | undefined =
    spaceIds === undefined || spaceIds.length > MAX_FILTER_VALUES
      ? undefined
      : spaceIds.length === 1
        ? { spaceId: { $eq: spaceIds[0]! } }
        : { spaceId: { $in: spaceIds } };
  const response = await vectors().send(
    new QueryVectorsCommand({
      indexArn: INDEX_ARN,
      topK: options.topK,
      queryTexts: [
        { text, metadataKey: 'body' },
        { text, metadataKey: 'title' },
      ],
      ...(options.vector ? { queryVector: { float32: await embed(text) } } : {}),
      ...(filter === undefined ? {} : { filter }),
      returnMetadata: true,
      returnScores: true,
    }),
  );

  // Chunks come back in fused order; the first chunk of a page stands for it.
  const byPage = new Map<string, IndexHit>();
  for (const hit of response.vectors ?? []) {
    const metadata = hit.metadata as { spaceId?: string; pageId?: string; body?: string } | undefined;
    const matchedText = (hit.scores?.bm25Scores?.length ?? 0) > 0;
    const distance = hit.scores?.vectorDistance;
    if (!matchedText && (distance === undefined || distance > MAX_VECTOR_DISTANCE)) continue;
    if (metadata?.spaceId === undefined || metadata.pageId === undefined) continue;
    if (byPage.has(metadata.pageId)) continue;
    byPage.set(metadata.pageId, {
      spaceId: metadata.spaceId,
      pageId: metadata.pageId,
      text: metadata.body ?? '',
      matchedText,
    });
  }
  return [...byPage.values()];
}

/**
 * The local stand-in: pages whose title or body contains the query, in one
 * space or in every space. It deliberately skips the multi-space narrowing, so
 * the caller's permission filter is what keeps unreadable spaces out — the
 * same gate that has the last word on AWS.
 */
async function searchLocally(
  spaceId: string | undefined,
  query: string,
  limit: number,
): Promise<IndexHit[]> {
  const spaceIds =
    spaceId !== undefined
      ? [spaceId]
      : (
          await valuesOf(table.query({ index: 'gsi1', where: { gsi1pk: { equals: ALL_SPACES } } }))
        ).map((item) => idOf(item.pk));
  const needle = query.normalize('NFKC').toLowerCase();
  const hits: IndexHit[] = [];
  for (const id of spaceIds) {
    const items = table.query({
      where: { pk: { equals: spacePk(id) }, sk: { beginsWith: PAGE_SK_PREFIX } },
    });
    for await (const { value: item } of items) {
      if (item.type !== 'PAGE' || kindOf(item) !== 'page') continue;
      const body = await readBody(item.bodyKey);
      const haystack = `${item.title ?? ''}\n${body}`.normalize('NFKC').toLowerCase();
      if (!haystack.includes(needle)) continue;
      hits.push({ spaceId: id, pageId: idOf(item.sk), text: body, matchedText: true });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/**
 * Keyword search — a per-space inverted index, built ahead of time and
 * evaluated in the handler's own memory.
 *
 * Semantic search ranks by embedding distance, which is the wrong tool for a
 * query that is a literal string — an identifier, a proper noun — where the
 * user wants the pages that *contain* it. This module provides that other
 * half: exact-term lookup over the same corpus the semantic index reads.
 *
 * The unit is the space. Each space owns one index file, rebuilt from scratch
 * by a debounced job whenever a page in it is saved or deleted; nothing ever
 * patches an index incrementally, so a corrupt file heals on the next save.
 * The file lives in the content bucket under `search-index/<spaceId>.json` —
 * it cannot live in the corpus bucket, because the KnowledgeBase block ingests
 * that bucket whole and would embed the index as if it were a document.
 *
 * ─── Two backends, same split as `search-corpus.ts` ─────────────────────────
 *   - AWS (`KEYWORD_INDEX_BUCKET` set): the index is an object in the content
 *     bucket, read and written with the S3 SDK. The block API is not used here
 *     because freshness is checked with `HeadObject`+ETag, which it does not
 *     expose. `index.cdk.ts` injects the bucket's physical name; the handler
 *     role already holds read/write on it through the block's own grant.
 *   - Local dev (unset): the index is a file under `.keyword-index/`, and the
 *     file's mtime+size stand in for the ETag.
 *
 * Between a save and the debounced rebuild, the page is simply absent from
 * keyword search — the same freshness trade re-ingestion already makes for
 * semantic search.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AsyncJob } from '@aws-blocks/blocks';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { REINGEST_DEBOUNCE_SECONDS } from './reingest.js';
import { SEARCH_CORPUS_LOCAL_DIR, scope } from './resources.js';

// ─── Tokenization ────────────────────────────────────────────────────────────

/**
 * Split text into search terms.
 *
 * NFKC-normalized and lowercased first, so full-width "ＡＷＳ" and "aws" meet
 * on the same term. Then the text is walked as runs of word characters:
 * an ASCII-alphanumeric run becomes one term as it stands, and any other run
 * of letters/digits (Japanese above all) becomes overlapping two-character
 * bigrams. No morphological analyzer: a dictionary in the Lambda bundle costs
 * more in cold starts than a wiki's search gains in precision.
 *
 * A non-ASCII run of length one yields no bigram and therefore no term — a
 * single-character query is out of keyword search's reach by design, and the
 * title prefix search is what answers it.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  let run: string[] = [];
  let runClass: 'ascii' | 'word' | null = null;
  const flush = () => {
    if (runClass === 'ascii') {
      terms.push(run.join(''));
    } else if (runClass === 'word') {
      for (let i = 0; i + 1 < run.length; i += 1) {
        terms.push(run[i]! + run[i + 1]!);
      }
    }
    run = [];
    runClass = null;
  };
  for (const ch of text.normalize('NFKC').toLowerCase()) {
    // `\p{M}` keeps combining marks attached to the letter they modify.
    const cls = /[a-z0-9]/.test(ch) ? 'ascii' : /[\p{L}\p{N}\p{M}]/u.test(ch) ? 'word' : null;
    if (cls !== runClass) flush();
    if (cls === null) continue;
    runClass = cls;
    run.push(ch);
  }
  flush();
  return terms;
}

// ─── Index structure ─────────────────────────────────────────────────────────

/** The serialized index — what `search-index/<spaceId>.json` holds. */
export type SerializedIndex = {
  version: 2;
  /**
   * One entry per corpus document: `[pageId, term count, title]`.
   *
   * The title rides along so the suggestion endpoint can match titles without
   * reading every page of every readable space out of DynamoDB on each
   * keystroke. It is a copy, stale between a rename and the next rebuild, and
   * is used for *matching* only — what a result displays is the live title
   * read from the table.
   */
  docs: [string, number, string][];
  /** Term → flat postings `[doc index, term frequency, doc index, tf, …]`. */
  postings: Record<string, number[]>;
};

/**
 * The in-memory form the searcher evaluates.
 *
 * Postings become a `Map` on load, deliberately: the terms are user-written
 * text, and looking them up on a plain object would let a page containing
 * "constructor" collide with `Object.prototype`.
 */
export type LoadedIndex = {
  docs: [string, number, string][];
  postings: Map<string, number[]>;
  avgLength: number;
  /**
   * The titles as they are compared, in `docs` order.
   *
   * Normalizing is not free, and a suggestion arrives per keystroke, so it
   * happens once when the file is parsed — which is once per execution
   * environment per index version — rather than once per document per request.
   */
  matchTitles: string[];
};

/** Build a space's index from its corpus documents. */
export function buildIndex(
  documents: { pageId: string; text: string; title?: string }[],
): SerializedIndex {
  const docs: [string, number, string][] = [];
  const postings = new Map<string, number[]>();
  for (const doc of documents) {
    const terms = tokenize(doc.text);
    const docIndex = docs.length;
    docs.push([doc.pageId, terms.length, doc.title ?? '']);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    for (const [term, tf] of frequencies) {
      const posting = postings.get(term) ?? [];
      posting.push(docIndex, tf);
      postings.set(term, posting);
    }
  }
  return { version: 2, docs, postings: Object.fromEntries(postings) };
}

/**
 * Parse a serialized index into the form `searchIndex` evaluates.
 *
 * Version 1 — written before titles rode along — is read as it stands, with an
 * empty title per document: those spaces answer body searches normally and
 * simply match no titles until their next rebuild. A version *above* what this
 * code knows is refused instead, which is what keeps a future format change
 * from being silently misread by old code; `searchKeyword` catches the throw
 * per space, treats the file as absent, and asks for a rebuild.
 */
export function parseIndex(json: string): LoadedIndex {
  const parsed = JSON.parse(json) as { version: number } & Omit<SerializedIndex, 'version'>;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unknown keyword index version: ${String(parsed.version)}`);
  }
  const docs = parsed.docs.map(
    ([pageId, length, title]) => [pageId, length, title ?? ''] as [string, number, string],
  );
  const total = docs.reduce((sum, [, length]) => sum + length, 0);
  return {
    docs,
    postings: new Map(Object.entries(parsed.postings)),
    avgLength: docs.length === 0 ? 1 : total / docs.length,
    matchTitles: docs.map(([, , title]) => forMatching(title)),
  };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

// Standard BM25 constants: k1 saturates repeated occurrences, b normalizes for
// document length.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Evaluate a query against one space's index.
 *
 * AND semantics: a document must contain *every* query term. With bigram
 * terms that approximates substring match — "東京タワー" only returns pages
 * where all four bigrams appear — which is what a user typing a keyword means.
 * Ranking is BM25 summed over the query terms.
 */
export function searchIndex(
  index: LoadedIndex,
  query: string,
  limit: number,
): { pageId: string; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.docs.length === 0) return [];
  const n = index.docs.length;

  const matched = new Map<number, { count: number; score: number }>();
  for (const term of terms) {
    const posting = index.postings.get(term);
    // A term nobody contains empties the intersection — done.
    if (posting === undefined) return [];
    const df = posting.length / 2;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < posting.length; i += 2) {
      const docIndex = posting[i]!;
      const tf = posting[i + 1]!;
      const length = index.docs[docIndex]?.[1] ?? 0;
      const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / index.avgLength);
      const gain = idf * ((tf * (BM25_K1 + 1)) / norm);
      const row = matched.get(docIndex) ?? { count: 0, score: 0 };
      row.count += 1;
      row.score += gain;
      matched.set(docIndex, row);
    }
  }

  return [...matched.entries()]
    .filter(([, row]) => row.count === terms.length)
    .map(([docIndex, row]) => ({ pageId: index.docs[docIndex]![0], score: row.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Query and title on the same footing: NFKC-normalized, lowercased. */
const forMatching = (text: string) => text.normalize('NFKC').toLowerCase().trim();

/**
 * Titles that begin with what has been typed so far.
 *
 * This is the half of suggestions that answers a query too short for the
 * inverted index: one character makes no bigram and therefore no term, but it
 * is a perfectly good start of a title. Shorter titles rank first — the fewer
 * characters left over, the closer the title is to what was typed.
 */
export function searchTitlePrefix(
  index: LoadedIndex,
  query: string,
  limit: number,
): { pageId: string; title: string }[] {
  const prefix = forMatching(query);
  if (prefix === '') return [];
  // Ranked on the compared form — the same string the prefix was tested
  // against — so a full-width title does not sort as if it were longer. What
  // comes back is the title as written.
  return index.docs
    .map(([pageId, , title], docIndex) => ({
      pageId,
      title,
      matchTitle: index.matchTitles[docIndex] ?? '',
    }))
    .filter((doc) => doc.matchTitle !== '' && doc.matchTitle.startsWith(prefix))
    .sort(
      (a, b) =>
        a.matchTitle.length - b.matchTitle.length || a.matchTitle.localeCompare(b.matchTitle),
    )
    .slice(0, limit)
    .map(({ pageId, title }) => ({ pageId, title }));
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * The content bucket's physical name, injected by `index.cdk.ts`. Its presence
 * is also the AWS/local switch, exactly as `SEARCH_CORPUS_BUCKET` is for the
 * corpus module.
 */
const INDEX_BUCKET = process.env.KEYWORD_INDEX_BUCKET;
const CORPUS_BUCKET = process.env.SEARCH_CORPUS_BUCKET;

const onAws = INDEX_BUCKET !== undefined && INDEX_BUCKET !== '';

/** Where local dev keeps the index files, next to `.search-corpus`. */
export const KEYWORD_INDEX_LOCAL_DIR = '.keyword-index';

// Lazy for the same reason as `search-corpus.ts`: this module is imported
// during CDK synth, where an S3 client has no credentials to resolve.
let s3: S3Client | undefined;
const client = () => (s3 ??= new S3Client({}));

const indexKey = (spaceId: string) => `search-index/${spaceId}.json`;
const localIndexPath = (spaceId: string) => join(KEYWORD_INDEX_LOCAL_DIR, `${spaceId}.json`);

/** A missing object, under either the HEAD (`NotFound`) or GET (`NoSuchKey`) spelling. */
function isMissing(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * One space's index kept on the execution environment, with the version it was
 * read at — the ETag on AWS, mtime+size locally. The same shape as the
 * permission-table reuse: cached, but revalidated against the source on every
 * request, so a search never runs on an index known to be stale.
 */
const cached = new Map<string, { version: string; index: LoadedIndex }>();

// A cross-space search loads one index per readable space, so what this map
// holds grows as spaces × index size with no natural ceiling. The cap bounds
// it; on overflow the oldest-written entries go first, and trimming to a lower
// mark keeps the eviction from running on every store once the cap is reached.
// The numbers are not measured — revisit with the rebuild job's size logs.
const CACHE_MAX_SPACES = 100;
const CACHE_TRIM_TO = 80;

/** Store one space's index, evicting the oldest-written entries past the cap. */
function storeCached(spaceId: string, entry: { version: string; index: LoadedIndex }): void {
  // Delete first: `Map` keeps insertion order, so re-inserting moves this
  // space to the back and the front stays the oldest write.
  cached.delete(spaceId);
  cached.set(spaceId, entry);
  if (cached.size <= CACHE_MAX_SPACES) return;
  for (const key of cached.keys()) {
    if (cached.size <= CACHE_TRIM_TO) break;
    cached.delete(key);
  }
}

/** Load a space's index, reusing the cached copy while its version still matches. */
async function loadIndex(spaceId: string): Promise<LoadedIndex | null> {
  const held = cached.get(spaceId);
  if (onAws) {
    let version: string;
    try {
      const head = await client().send(
        new HeadObjectCommand({ Bucket: INDEX_BUCKET, Key: indexKey(spaceId) }),
      );
      version = head.ETag ?? '';
    } catch (error: unknown) {
      if (isMissing(error)) return null; // No index yet — the space has no pages, or the first build is pending.
      throw error;
    }
    if (held !== undefined && held.version === version && version !== '') return held.index;
    const object = await client().send(
      new GetObjectCommand({ Bucket: INDEX_BUCKET, Key: indexKey(spaceId) }),
    );
    const index = parseIndex((await object.Body?.transformToString('utf8')) ?? '{"version":1,"docs":[],"postings":{}}');
    // The GET's own ETag, not the HEAD's: if a rebuild lands between the two
    // calls, the cache must be stamped with the version actually read.
    storeCached(spaceId, { version: object.ETag ?? '', index });
    return index;
  }
  let version: string;
  try {
    const info = await stat(localIndexPath(spaceId));
    version = `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
  if (held !== undefined && held.version === version) return held.index;
  const index = parseIndex(await readFile(localIndexPath(spaceId), 'utf8'));
  storeCached(spaceId, { version, index });
  return index;
}

// ─── Search across spaces ────────────────────────────────────────────────────

/**
 * Keyword search over the given spaces, best hits first.
 *
 * The caller passes only spaces it already resolved `read` on, so no index of
 * an unreadable space is even opened — the final `filterReadable` in
 * `searchPages` stays as the gate for permissions that changed since the
 * indexes were built. BM25 scores from different spaces are compared as they
 * are; the fusion downstream only consumes the order.
 */
export async function searchKeyword(
  spaceIds: string[],
  query: string,
  limit: number,
): Promise<{ spaceId: string; pageId: string; score: number }[]> {
  // A query that yields no terms (a single Japanese character, punctuation)
  // can match nothing, so skip the per-space freshness round trips entirely.
  if (tokenize(query).length === 0) return [];
  const perSpace = await Promise.all(
    spaceIds.map(async (spaceId) => {
      try {
        const index = await loadIndex(spaceId);
        if (index === null) return [];
        return searchIndex(index, query, limit).map((hit) => ({ spaceId, ...hit }));
      } catch {
        // One space's unreadable index — corrupt JSON, an unknown version, a
        // throttled S3 call — must not take the whole search down: the
        // semantic half and the other spaces still answer, the same degraded
        // shape a not-yet-ready semantic index already has. Asking for a
        // rebuild is what heals a corrupt file without waiting for the next
        // save; for a transient S3 error it only rewrites the same index.
        await requestKeywordIndex(spaceId);
        return [];
      }
    }),
  );
  return perSpace
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Suggestions for a query still being typed: title prefixes first, then the
 * pages whose text the inverted index matches.
 *
 * Only the two searches that answer out of memory. The semantic half is left
 * to the search the user commits to with Enter — it is a network round trip to
 * Bedrock, which no keystroke should wait on.
 *
 * Unlike `searchKeyword` this does not give up on a query that yields no
 * terms: one character makes no bigram, but it is the ordinary case for a
 * title prefix, and answering it here is what keeps a short query from
 * reaching only the semantic search.
 *
 * The caller passes only spaces it resolved `read` on, and the result still
 * goes through `filterReadable` upstream — the same two-layer arrangement
 * `searchKeyword` documents.
 */
export async function suggestKeyword(
  spaceIds: string[],
  query: string,
  limit: number,
): Promise<{ spaceId: string; pageId: string }[]> {
  if (query.trim() === '') return [];
  const perSpace = await Promise.all(
    spaceIds.map(async (spaceId) => {
      try {
        const index = await loadIndex(spaceId);
        if (index === null) return null;
        return {
          titles: searchTitlePrefix(index, query, limit).map((hit) => ({ spaceId, ...hit })),
          body: searchIndex(index, query, limit).map((hit) => ({ spaceId, ...hit })),
        };
      } catch {
        // One space's unreadable index costs its own suggestions, never the
        // whole request. Unlike `searchKeyword` this does *not* ask for a
        // rebuild: suggestions run per keystroke, and a corrupt file or a
        // throttled S3 would otherwise queue one full-space rebuild for every
        // character typed. The search behind Enter, and the next save, still
        // heal it.
        return null;
      }
    }),
  );
  const found = perSpace.filter((entry) => entry !== null);
  const titles = found
    .flatMap((entry) => entry.titles)
    .sort((a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title));
  const body = found.flatMap((entry) => entry.body).sort((a, b) => b.score - a.score);

  // Title matches first: someone typing the start of a name is naming a page,
  // not describing one. The order is the only place that distinction is
  // recorded — the screen shows no badge for where a suggestion came from.
  const out: { spaceId: string; pageId: string }[] = [];
  const seen = new Set<string>();
  const take = (hits: { spaceId: string; pageId: string }[]) => {
    for (const hit of hits) {
      if (out.length >= limit) break;
      const key = `${hit.spaceId}/${hit.pageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ spaceId: hit.spaceId, pageId: hit.pageId });
    }
  };
  take(titles);
  take(body);
  return out;
}

// ─── Rebuild job ─────────────────────────────────────────────────────────────

export const keywordIndexPayload = z.object({ spaceId: z.string().min(1) });

/**
 * The debounce, aligned with re-ingestion so both indexes go stale and catch
 * up on the same rhythm. Locally there is no ingestion cost to amortize and a
 * developer is watching, so the rebuild follows the save almost immediately.
 */
export const KEYWORD_INDEX_DEBOUNCE_SECONDS = onAws ? REINGEST_DEBOUNCE_SECONDS : 1;

/**
 * The page title a corpus document leads with.
 *
 * `normalizeForCorpus` writes it as the opening `# ` heading, so it is read
 * back from there rather than from a second DynamoDB read per page. A document
 * without that heading belongs to an untitled page and matches no prefix.
 */
export function titleOfCorpus(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  return firstLine.startsWith('# ') ? firstLine.slice(2).trim() : '';
}

/** Read one space's corpus documents — the same files the KnowledgeBase ingests. */
async function readCorpus(spaceId: string): Promise<{ pageId: string; text: string }[]> {
  if (onAws) {
    const prefix = `${spaceId}/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client().send(
        new ListObjectsV2Command({
          Bucket: CORPUS_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        // Skip the `.metadata.json` sidecars — they are routing data, not text.
        if (object.Key !== undefined && object.Key.endsWith('.md')) keys.push(object.Key);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return await Promise.all(
      keys.map(async (key) => {
        const object = await client().send(
          new GetObjectCommand({ Bucket: CORPUS_BUCKET, Key: key }),
        );
        return {
          pageId: key.slice(prefix.length, -'.md'.length),
          text: (await object.Body?.transformToString('utf8')) ?? '',
        };
      }),
    );
  }
  let names: string[];
  try {
    names = await readdir(join(SEARCH_CORPUS_LOCAL_DIR, spaceId));
  } catch {
    return []; // No corpus folder — the space has no pages.
  }
  return await Promise.all(
    names
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => ({
        pageId: name.slice(0, -'.md'.length),
        text: await readFile(join(SEARCH_CORPUS_LOCAL_DIR, spaceId, name), 'utf8'),
      })),
  );
}

/** Write (or, for an empty corpus, remove) a space's index file. */
async function storeIndex(spaceId: string, index: SerializedIndex | null): Promise<void> {
  if (onAws) {
    if (index === null) {
      await client().send(
        new DeleteObjectCommand({ Bucket: INDEX_BUCKET, Key: indexKey(spaceId) }),
      );
      return;
    }
    await client().send(
      new PutObjectCommand({
        Bucket: INDEX_BUCKET,
        Key: indexKey(spaceId),
        Body: JSON.stringify(index),
        ContentType: 'application/json',
      }),
    );
    return;
  }
  if (index === null) {
    await rm(localIndexPath(spaceId), { force: true });
    return;
  }
  await mkdir(KEYWORD_INDEX_LOCAL_DIR, { recursive: true });
  await writeFile(localIndexPath(spaceId), JSON.stringify(index), 'utf8');
}

/**
 * Rebuild one space's index from its current corpus, whole.
 *
 * Always the full space, never a delta: the corpus at the time the job *runs*
 * is the truth, so one run after a burst of saves covers all of them, and an
 * index damaged in any way is replaced wholesale on the next save. An empty
 * corpus removes the file — a deleted space leaves nothing behind.
 */
export const keywordIndexJob = new AsyncJob(scope, 'keyword-index', {
  schema: keywordIndexPayload,
  handler: async ({ spaceId }) => {
    const documents = await readCorpus(spaceId);
    if (documents.length === 0) {
      await storeIndex(spaceId, null);
      return;
    }
    const index = buildIndex(
      documents.map((doc) => ({ ...doc, title: titleOfCorpus(doc.text) })),
    );
    const body = JSON.stringify(index);
    await storeIndex(spaceId, index);
    // One line per rebuild, on purpose: the single-file-per-space design has a
    // size ceiling that has not been measured yet, and these numbers are the
    // measurement.
    console.log(
      `[keyword-index] rebuilt space ${spaceId}: ${documents.length} docs, ` +
        `${Object.keys(index.postings).length} terms, ${Buffer.byteLength(body)} bytes`,
    );
  },
});

/**
 * Ask for a space's index to be rebuilt, best-effort.
 *
 * Swallowed on failure for the same reason `requestReingest` is: the index is
 * derived, the pages themselves are already safe, and the next save of the
 * space files another request.
 */
export async function requestKeywordIndex(spaceId: string): Promise<void> {
  await keywordIndexJob
    .submit({ spaceId }, { delaySeconds: KEYWORD_INDEX_DEBOUNCE_SECONDS })
    .catch(() => {});
}

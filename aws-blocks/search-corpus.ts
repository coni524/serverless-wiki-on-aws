/**
 * Search corpus — the normalized page text the KnowledgeBase block ingests.
 *
 * The KnowledgeBase block is built for a *static* document set: it reads its
 * source once at deploy time (AWS) or on first `retrieve()` (mock), and exposes
 * no runtime write API. A Wiki is not static, so the corpus is maintained on the
 * outside of the block: every page save writes one normalized markdown file
 * here, and every delete removes it. A separate re-ingestion step (`reingest.ts`)
 * then tells Bedrock to re-read the corpus.
 *
 * One file per page, laid out as `<spaceId>/<pageId>.md`. The top-level subfolder
 * is the space id, which the block turns into the `folder` metadata key — that is
 * what lets a single-space search pre-filter with `filter: { folder: { equals:
 * spaceId } }`. The pre-filter is only a narrowing, never the authorization: the
 * search API still passes every hit through `filterReadable` before returning it.
 *
 * ─── Two backends, chosen once by the environment ────────────────────────────
 * The block reads a *local folder* in the mock and an *s3:// bucket* on AWS
 * (`index.cdk.ts` resolves which via `SEARCH_CORPUS_BUCKET`). This module writes
 * to whichever the block will read:
 *
 *   - AWS (`SEARCH_CORPUS_BUCKET` set): PUT/DELETE against the corpus bucket with
 *     the S3 SDK. The block imports the same bucket as its `s3://` source.
 *   - Local dev (unset): write files under `./.search-corpus`, the same folder
 *     `resources.ts` hands the block as its source.
 *
 * The paths are the app's own in both cases — nothing here reaches into a block's
 * internal mock layout, so a change to how a block stores its mock data cannot
 * break search.
 */
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { REINGEST_DEBOUNCE_SECONDS, reingestJob } from './reingest.js';
import { SEARCH_CORPUS_LOCAL_DIR } from './resources.js';

/**
 * The corpus bucket on AWS, injected by `index.cdk.ts`. Its presence is also the
 * one signal this module uses to tell AWS from the local mock: unset means the
 * dev server, where the corpus is a folder on disk and Bedrock is not involved.
 */
const CORPUS_BUCKET = process.env.SEARCH_CORPUS_BUCKET;

/** `true` on a deployed stack, `false` under `pnpm dev` / the mock. */
export const onAws = CORPUS_BUCKET !== undefined && CORPUS_BUCKET !== '';

// The client is created lazily: this module is imported during CDK synth too
// (through `index.ts`), where constructing an S3 client would try to resolve
// credentials for no reason.
let s3: S3Client | undefined;
const client = () => (s3 ??= new S3Client({}));

/** The key of one page's corpus document. The space id leads so it becomes `folder`. */
export const corpusKey = (spaceId: string, pageId: string) => `${spaceId}/${pageId}.md`;

/**
 * The Bedrock metadata sidecar (`<key>.metadata.json`) that carries a document's
 * `folder` attribute — the value the single-space pre-filter matches on.
 *
 * On a *local folder* source the KnowledgeBase block generates these sidecars at
 * deploy time, and its mock derives `folder` from the path directly. On an
 * imported `s3://` source it generates nothing: documents (and their sidecars)
 * are expected to already be in the bucket. This corpus is written at runtime,
 * so the sidecar has to be written here, next to each document, in the same
 * format the block's own generator uses — otherwise the deployed index has no
 * `folder` attribute and `filter: { folder: { equals: spaceId } }` matches
 * nothing (found on the first sandbox deploy; the mock had hidden it).
 */
const sidecarKey = (key: string) => `${key}.metadata.json`;
const sidecarBody = (spaceId: string) =>
  JSON.stringify({
    metadataAttributes: {
      folder: { value: { type: 'STRING', stringValue: spaceId } },
    },
  });

/** Path under the local corpus folder, for the mock backend. */
const localPath = (key: string) => join(SEARCH_CORPUS_LOCAL_DIR, key);

/**
 * The text the block indexes for a page.
 *
 * Title as the leading heading, then the body. The title carries real signal —
 * a page is often found by its name — so it is worth a heading rather than being
 * dropped. Nothing else is embedded: the space and page ids are recoverable from
 * the document's own path (`<spaceId>/<pageId>.md`) and its `folder` metadata, so
 * duplicating them in the text would only dilute the embedding.
 */
export function normalizeForCorpus(title: string, body: string): string {
  const heading = title.trim();
  const text = body ?? '';
  return heading === '' ? text : `# ${heading}\n\n${text}`;
}

/** Write (or overwrite) one page's corpus document. */
export async function writeCorpus(spaceId: string, pageId: string, markdown: string): Promise<void> {
  const key = corpusKey(spaceId, pageId);
  if (onAws) {
    // Sidecar first, document second — the order decides what a failure
    // between the two writes leaves behind. An orphan sidecar is inert (the
    // block never indexes `.metadata.json` as a document), while a document
    // without its sidecar would be ingested with no `folder` attribute and
    // stay invisible to the single-space pre-filter until the next save.
    // Writing the sidecar unconditionally (not only on create) also keeps the
    // pair self-healing: a lost sidecar comes back with the next save.
    await client().send(
      new PutObjectCommand({
        Bucket: CORPUS_BUCKET,
        Key: sidecarKey(key),
        Body: sidecarBody(spaceId),
        ContentType: 'application/json',
      }),
    );
    await client().send(
      new PutObjectCommand({
        Bucket: CORPUS_BUCKET,
        Key: key,
        Body: markdown,
        ContentType: 'text/markdown; charset=utf-8',
      }),
    );
  } else {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, 'utf8');
  }
}

/**
 * Remove the corpus documents of several pages in one call.
 *
 * Used by the delete paths, which already hold the set of doomed pages. Bounded
 * by the caller (a cascading page delete is capped, and a space delete removes
 * pages in pages of 100), so this never has to sweep an unbounded prefix.
 */
export async function deleteCorpusBatch(
  pages: Array<{ spaceId: string; pageId: string }>,
): Promise<void> {
  if (pages.length === 0) return;
  // Each page owns two objects on AWS: the document and its metadata sidecar.
  // Locally only the document exists (the mock derives `folder` from the path),
  // but removing a sidecar that never existed is a no-op either way.
  const keys = pages.flatMap((p) => {
    const key = corpusKey(p.spaceId, p.pageId);
    return [key, sidecarKey(key)];
  });
  if (onAws) {
    // DeleteObjects takes at most 1,000 keys; the callers stay well under that,
    // but chunk anyway so the bound lives here rather than in every caller.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await client().send(
        new DeleteObjectsCommand({
          Bucket: CORPUS_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  } else {
    await Promise.all(keys.map((key) => rm(localPath(key), { force: true })));
  }
}

/**
 * Ask for the corpus to be re-ingested, best-effort.
 *
 * Only meaningful on AWS: the mock reads the corpus folder directly, so a write
 * is visible without any ingestion step. On AWS this hands the work to a
 * debounced job (`reingest.ts`) so a burst of saves collapses into few ingestion
 * runs. Swallowed on failure on purpose — a missed re-ingestion only delays when
 * the change surfaces in search, and the next save requests another.
 */
export async function requestReingest(): Promise<void> {
  if (!onAws) return;
  await reingestJob.submit({}, { delaySeconds: REINGEST_DEBOUNCE_SECONDS }).catch(() => {});
}

/**
 * Bring the search index in step with a saved page, best-effort.
 *
 * The corpus is a *derived* index, so a failure to update it must never fail the
 * save itself: the page — its body in S3, its metadata in DynamoDB — is already
 * the source of truth by the time this runs. A dropped update only leaves the
 * page stale in search until its next edit, the freshness trade the design
 * already accepts. Failing the save instead would be worse than the staleness it avoids:
 * `createPage` mints a fresh page id on every attempt, so a client retrying a
 * save that "failed" only on the index would create a duplicate page. Errors are
 * swallowed for that reason.
 */
export async function indexPage(spaceId: string, pageId: string, markdown: string): Promise<void> {
  try {
    await writeCorpus(spaceId, pageId, markdown);
  } catch {
    // Derived index — see the note above; the next save re-indexes the page.
  }
  await requestReingest();
}

/**
 * Drop pages from the search index, best-effort (same reasoning as `indexPage`).
 *
 * A failure here leaves a document for an already-deleted page — a ghost the
 * search API drops when it confirms the page no longer exists, so nothing leaks;
 * only the S3 object and its vector linger until the next re-ingestion.
 */
export async function unindexPages(
  pages: Array<{ spaceId: string; pageId: string }>,
): Promise<void> {
  try {
    await deleteCorpusBatch(pages);
  } catch {
    // Derived index — a lingering ghost is filtered out on read.
  }
  await requestReingest();
}

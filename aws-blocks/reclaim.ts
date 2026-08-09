/**
 * Reclaiming S3 objects behind a deleted page or space.
 *
 * Deleting is two-phase on purpose. The API removes the DynamoDB metadata
 * synchronously, which is what makes the page disappear for the caller, and
 * leaves behind a `CLEANUP` record naming the S3 prefix that still holds the
 * bodies and attachments. This job sweeps that prefix afterwards.
 *
 * Doing it synchronously was rejected: the object count of a space has no upper
 * bound, so nothing guarantees the sweep fits in API Gateway's 29 seconds, and
 * an interrupted sweep would leave no record of how far it got. Leaving the
 * objects in place was rejected too — unreachable is not the same as deleted,
 * and a request to erase a departed employee's space asks for the latter.
 *
 * The record is written before anything is deleted, so a run that dies part-way
 * still leaves the promise behind for a later retry.
 */
import { AsyncJob } from '@aws-blocks/blocks';
import { z } from 'zod';

import { content, scope, table } from './resources.js';
import { CLEANUP_PK } from './model.js';

/**
 * How long one invocation sweeps before handing off.
 *
 * The Lambda ceiling is 900 seconds. Stopping at 600 leaves room to submit the
 * continuation and return normally, so a large space is reclaimed by a chain of
 * jobs rather than by a timeout and a retry that starts over.
 */
const BUDGET_MS = 600_000;

/** `deleteBatch()` chunks at 1,000 internally; collecting more buys nothing. */
const SWEEP_BATCH = 1_000;

export const reclaimPayload = z.object({
  /** Sort keys of the `CLEANUP` records to sweep, in the order given. */
  handles: z.array(z.string().min(1)).min(1).max(200),
});

export const reclaimJob = new AsyncJob(scope, 'reclaim', {
  schema: reclaimPayload,
  handler: async (payload: z.infer<typeof reclaimPayload>) => {
    const startedAt = Date.now();
    const pending = [...payload.handles];

    while (pending.length > 0) {
      const handle = pending[0]!;
      const record = await table.get({ pk: CLEANUP_PK, sk: handle });
      // Already reclaimed — by an earlier attempt of this same job, or by the
      // administrator's manual retry. Nothing to do, and nothing to report.
      if (record === null || record.prefix === undefined) {
        pending.shift();
        continue;
      }

      const exhausted = await sweep(record.prefix, startedAt);
      if (!exhausted) {
        // Out of time with objects still under the prefix. The record stays,
        // so the continuation resumes from whatever is left.
        await reclaimJob.submit({ handles: pending });
        return;
      }

      // The prefix is empty, so the promise is kept and the record goes. Losing
      // the process between these two lines only costs an extra empty sweep.
      await table.delete({ pk: CLEANUP_PK, sk: handle });
      pending.shift();

      if (Date.now() - startedAt > BUDGET_MS && pending.length > 0) {
        await reclaimJob.submit({ handles: pending });
        return;
      }
    }
  },
});

/**
 * Delete everything under `prefix`. Returns false if the budget ran out first.
 *
 * Idempotent: deleting an already-deleted key is a no-op, so a re-run only ever
 * removes what the previous one did not reach. Because the bodies are ordinary
 * objects rather than S3 versions, whatever survives is still visible to the
 * next `scan()` — a versioned bucket would hide it behind a delete marker and
 * leave no way to tell a finished sweep from an unfinished one.
 */
async function sweep(prefix: string, startedAt: number): Promise<boolean> {
  for (;;) {
    // One round lists a batch, stops listing, and deletes it. Deleting while
    // the iterator is still open would mutate the listing underneath it, and
    // starting each round from the top of the prefix costs nothing extra —
    // everything the previous round removed is already gone from the listing.
    const batch: string[] = [];
    for await (const file of content.scan({ prefix })) {
      batch.push(file.path);
      if (batch.length >= SWEEP_BATCH) break;
    }
    if (batch.length === 0) return true;
    await content.deleteBatch(batch);
    if (Date.now() - startedAt > BUDGET_MS) return false;
  }
}

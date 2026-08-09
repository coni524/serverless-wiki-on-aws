/**
 * Re-ingestion of the search corpus.
 *
 * The KnowledgeBase block ingests its source at deploy time and offers no runtime
 * "re-read your documents" call, so a Wiki whose pages change after deploy needs
 * one added on the outside. This job is it: after the corpus on S3 changes, a
 * debounced job asks Bedrock to re-ingest the data source with `StartIngestionJob`
 * — the one Bedrock API the block does not wrap, called here with the AWS SDK and
 * backed by an IAM grant added through a CDK escape hatch in `index.cdk.ts`.
 *
 * The debounce is the job's `delaySeconds` (see `search-corpus.ts`): an ingestion
 * run re-reads the whole corpus when it *runs*, so one run after a burst of saves
 * already covers all of them, and delaying lets a burst collapse into few runs.
 *
 * On the mock this job never has anything to do — the mock reads the corpus folder
 * straight off disk — and `requestReingest()` does not even submit it there. The
 * handler still guards on the knowledge-base id so a stray invocation is a no-op
 * rather than an error.
 */
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import { AsyncJob } from '@aws-blocks/blocks';
import { z } from 'zod';

import { scope } from './resources.js';

/** The job carries no data: it always re-ingests the current corpus in full. */
export const reingestPayload = z.object({});

/**
 * How long the re-ingestion job waits before running — the debounce.
 *
 * An ingestion run re-reads the *whole* corpus at the time it runs, not the time
 * it was requested, so a single run started after a burst of saves already
 * reflects all of them. Delaying the run lets rapid successive saves collapse
 * into few ingestions instead of one per save.
 */
export const REINGEST_DEBOUNCE_SECONDS = 30;

/**
 * The knowledge base and data source to re-ingest.
 *
 * The KnowledgeBase block injects `BLOCKS_{FULLID}_KB_ID` and
 * `BLOCKS_{FULLID}_DATA_SOURCE_ID` into the handler. Rather than reconstruct the
 * exact `{FULLID}` (an internal detail of how the block derives env-var names),
 * this finds the one pair present — there is a single KnowledgeBase in the app,
 * so exactly one of each exists — which stays correct if that naming ever changes.
 */
function ingestionTarget(): { knowledgeBaseId: string; dataSourceId: string } | null {
  const find = (suffix: string) =>
    Object.entries(process.env).find(
      ([key, value]) => key.startsWith('BLOCKS_') && key.endsWith(suffix) && value,
    )?.[1];
  const knowledgeBaseId = find('_KB_ID');
  const dataSourceId = find('_DATA_SOURCE_ID');
  if (knowledgeBaseId === undefined || dataSourceId === undefined) return null;
  return { knowledgeBaseId, dataSourceId };
}

let agent: BedrockAgentClient | undefined;
const client = () => (agent ??= new BedrockAgentClient({}));

export const reingestJob = new AsyncJob(scope, 'reingest', {
  schema: reingestPayload,
  handler: async () => {
    const target = ingestionTarget();
    // No target means the mock, or a deployment predating the sync env vars.
    // Either way there is nothing this job can drive; the mock stays fresh on
    // its own.
    if (target === null) return;

    try {
      await client().send(new StartIngestionJobCommand(target));
    } catch (error: unknown) {
      // Bedrock permits only one ingestion job per data source at a time and
      // rejects a second with a conflict. A run is already in flight, but it may
      // have started reading the corpus before this change landed, so rather than
      // drop the request, re-arm it behind the debounce: the follow-up runs once
      // the current job frees the data source and re-reads the corpus as it then
      // stands. This closes the tail where the last save of a burst would
      // otherwise never be ingested. Best-effort — a lost re-arm only delays
      // freshness, which the design accepts.
      if (isConflict(error)) {
        await reingestJob.submit({}, { delaySeconds: REINGEST_DEBOUNCE_SECONDS }).catch(() => {});
        return;
      }
      throw error;
    }
  },
});

/** A concurrent-ingestion rejection, matched by the SDK error's name. */
function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'ConflictException'
  );
}

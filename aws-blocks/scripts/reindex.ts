/**
 * Rebuild every space's keyword index, once, from the current search corpus.
 *
 *   AWS:    AWS_PROFILE=<profile> pnpm run reindex -- --stack <stack-name>
 *   local:  pnpm run reindex -- --local
 *
 * The index of a space is normally rebuilt by the debounced job that a page
 * save or delete starts, so a space nobody has edited since a change to the
 * index format keeps whatever it had. That is the gap this closes: after a
 * deployment that changes the format — the titles that title-prefix
 * suggestions match on were added this way — an operator runs this once, and
 * every space is on the current format without waiting for someone to edit a
 * page in it.
 *
 * It writes exactly what the job writes, through the same `buildIndex`, so
 * there is no second implementation of the format to keep in step. Running it
 * when nothing is stale is harmless: each space is rebuilt from its corpus,
 * which is the same content the job would have read.
 *
 * The bucket names are read from the deployed handler's own environment rather
 * than asked of the operator, because that is where the application itself
 * gets them and a mistyped bucket would write an index nobody reads.
 */
import { execFile } from 'node:child_process';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  KEYWORD_INDEX_LOCAL_DIR,
  buildIndex,
  titleOfCorpus,
  type SerializedIndex,
} from '../keyword-index.js';
import { SEARCH_CORPUS_LOCAL_DIR } from '../resources.js';

const run = promisify(execFile);

/** One AWS CLI call, parsed as JSON. The operator's `aws` already has credentials. */
async function awsCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run('aws', [...args, '--output', 'json']);
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

/** The corpus and index buckets, as the deployed handler knows them. */
async function bucketsOf(stackName: string): Promise<{ corpus: string; index: string }> {
  const resources = (await awsCli([
    'cloudformation',
    'describe-stack-resources',
    '--stack-name',
    stackName,
  ])) as { StackResources?: { ResourceType?: string; PhysicalResourceId?: string }[] };
  const functions = (resources.StackResources ?? [])
    .filter((resource) => resource.ResourceType === 'AWS::Lambda::Function')
    .map((resource) => resource.PhysicalResourceId)
    .filter((id): id is string => id !== undefined);

  for (const functionName of functions) {
    const config = (await awsCli([
      'lambda',
      'get-function-configuration',
      '--function-name',
      functionName,
    ])) as { Environment?: { Variables?: Record<string, string> } };
    const variables = config.Environment?.Variables ?? {};
    const corpus = variables.SEARCH_CORPUS_BUCKET;
    const index = variables.KEYWORD_INDEX_BUCKET;
    if (corpus !== undefined && corpus !== '' && index !== undefined && index !== '') {
      return { corpus, index };
    }
  }
  throw new Error(
    `No function in ${stackName} carries SEARCH_CORPUS_BUCKET and KEYWORD_INDEX_BUCKET.\n` +
      'Check the stack name with: aws cloudformation list-stacks',
  );
}

/** Where a space's documents and its index live, on either backend. */
type Store = {
  /** The id of every space that has a corpus. */
  spaceIds(): Promise<string[]>;
  /** One space's documents, `[pageId, markdown]`. */
  documents(spaceId: string): Promise<{ pageId: string; text: string }[]>;
  writeIndex(spaceId: string, index: SerializedIndex): Promise<void>;
};

function awsStore(buckets: { corpus: string; index: string }): Store {
  const s3 = new S3Client({});
  const listAll = async (prefix: string | undefined, delimiter: string | undefined) => {
    const keys: string[] = [];
    const prefixes: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: buckets.corpus,
          ...(prefix === undefined ? {} : { Prefix: prefix }),
          ...(delimiter === undefined ? {} : { Delimiter: delimiter }),
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      for (const common of page.CommonPrefixes ?? []) {
        if (common.Prefix !== undefined) prefixes.push(common.Prefix);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return { keys, prefixes };
  };

  return {
    async spaceIds() {
      // The corpus lays documents out as `<spaceId>/<pageId>.md`, so the
      // top-level common prefixes are exactly the spaces.
      const { prefixes } = await listAll(undefined, '/');
      return prefixes.map((prefix) => prefix.replace(/\/$/, ''));
    },
    async documents(spaceId) {
      const prefix = `${spaceId}/`;
      const { keys } = await listAll(prefix, undefined);
      // `.metadata.json` sidecars are routing data, not text.
      const documents = keys.filter((key) => key.endsWith('.md'));
      return await Promise.all(
        documents.map(async (key) => {
          const object = await s3.send(
            new GetObjectCommand({ Bucket: buckets.corpus, Key: key }),
          );
          return {
            pageId: key.slice(prefix.length, -'.md'.length),
            text: (await object.Body?.transformToString('utf8')) ?? '',
          };
        }),
      );
    },
    async writeIndex(spaceId, index) {
      await s3.send(
        new PutObjectCommand({
          Bucket: buckets.index,
          Key: `search-index/${spaceId}.json`,
          Body: JSON.stringify(index),
          ContentType: 'application/json',
        }),
      );
    },
  };
}

function localStore(): Store {
  return {
    async spaceIds() {
      try {
        return await readdir(SEARCH_CORPUS_LOCAL_DIR);
      } catch {
        return [];
      }
    },
    async documents(spaceId) {
      let names: string[];
      try {
        names = await readdir(join(SEARCH_CORPUS_LOCAL_DIR, spaceId));
      } catch {
        return [];
      }
      return await Promise.all(
        names
          .filter((name) => name.endsWith('.md'))
          .map(async (name) => ({
            pageId: name.slice(0, -'.md'.length),
            text: await readFile(join(SEARCH_CORPUS_LOCAL_DIR, spaceId, name), 'utf8'),
          })),
      );
    },
    async writeIndex(spaceId, index) {
      await mkdir(KEYWORD_INDEX_LOCAL_DIR, { recursive: true });
      await writeFile(
        join(KEYWORD_INDEX_LOCAL_DIR, `${spaceId}.json`),
        JSON.stringify(index),
        'utf8',
      );
    },
  };
}

/** Rebuild every space, reporting one line each. */
export async function reindex(
  store: Store,
  log: (line: string) => void = console.log,
): Promise<void> {
  const spaceIds = await store.spaceIds();
  log(`${spaceIds.length} space(s) with a corpus.`);
  for (const spaceId of spaceIds) {
    const documents = await store.documents(spaceId);
    if (documents.length === 0) {
      // A space whose corpus is empty has no index to write: the job removes
      // the file in that case, and one that was never written is already gone.
      log(`  ${spaceId}: no documents, left alone`);
      continue;
    }
    const index = buildIndex(
      documents.map((doc) => ({ ...doc, title: titleOfCorpus(doc.text) })),
    );
    await store.writeIndex(spaceId, index);
    log(
      `  ${spaceId}: ${documents.length} docs, ` +
        `${Object.keys(index.postings).length} terms, ` +
        `${Buffer.byteLength(JSON.stringify(index))} bytes`,
    );
  }
}

function usage(): never {
  console.error(
    'Usage:\n' +
      '  pnpm run reindex -- --stack <stack-name>   (deployed stack)\n' +
      '  pnpm run reindex -- --local                (local dev folders)\n',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--stack');
  const stackName = at === -1 ? undefined : args[at + 1];
  const local = args.includes('--local');
  if (local === (stackName !== undefined)) usage();

  if (local) {
    await reindex(localStore());
    return;
  }
  const buckets = await bucketsOf(stackName as string);
  console.log(`corpus: ${buckets.corpus}\nindex:  ${buckets.index}`);
  await reindex(awsStore(buckets));
}

// Guarded so the module can be imported without the CLI running too.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

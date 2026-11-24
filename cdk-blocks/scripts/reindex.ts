/**
 * Write every page of a deployed stack into its search index, once.
 *
 *   AWS_PROFILE=<profile> pnpm run reindex -- --stack <stack-name>
 *
 * Saves and deletes keep the index current on their own. This fills an index
 * with the pages that existed before it: after the first deploy that creates
 * it, or if it is ever recreated. Running it again is harmless — each chunk is
 * written by key and overwrites itself. It only writes: chunks of deleted pages
 * or leftovers of shrunk pages are not cleaned up here (the indexing job does
 * that on the next save or delete of the page).
 *
 * It writes through the same `writePage` the indexing job uses, so there is no
 * second implementation of the vector layout. The table, the content bucket
 * and the index are looked up in the stack by their logical ids rather than
 * asked of the operator, so a mistyped name cannot write an index nobody reads.
 *
 * There is no local mode: the dev server searches pages directly and has no
 * index to fill.
 */
import { execFile } from 'node:child_process';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { promisify } from 'node:util';

import { ALL_SPACES, META, PAGE_SK_PREFIX, idOf, spacePk } from '../model.js';

const run = promisify(execFile);

async function awsCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run('aws', [...args, '--output', 'json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

/** The one resource of a type whose logical id starts with `prefix`. */
function resourceOf(
  resources: { ResourceType?: string; LogicalResourceId?: string; PhysicalResourceId?: string }[],
  type: string,
  prefix: string,
): string {
  const found = resources.filter(
    (resource) => resource.ResourceType === type && resource.LogicalResourceId?.startsWith(prefix),
  );
  if (found.length !== 1 || found[0]!.PhysicalResourceId === undefined) {
    throw new Error(`Expected one ${type} named ${prefix}* in the stack, found ${found.length}.`);
  }
  return found[0]!.PhysicalResourceId;
}

type Wire = Record<string, { S?: string }>;

/** Every item of a query, followed to the end rather than trusting one call. */
async function queryAll(tableName: string, args: string[]): Promise<Wire[]> {
  const items: Wire[] = [];
  let startKey: string | undefined;
  for (;;) {
    const result = await awsCli([
      'dynamodb',
      'query',
      '--table-name',
      tableName,
      ...args,
      ...(startKey === undefined ? [] : ['--exclusive-start-key', startKey]),
    ]);
    items.push(...((result.Items ?? []) as Wire[]));
    if (result.LastEvaluatedKey === undefined) return items;
    startKey = JSON.stringify(result.LastEvaluatedKey);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stackName = args[args.indexOf('--stack') + 1];
  if (!args.includes('--stack') || stackName === undefined) {
    console.error('Usage: AWS_PROFILE=<profile> pnpm run reindex -- --stack <stack-name>');
    process.exit(1);
  }

  const { StackResourceSummaries: resources = [] } = (await awsCli([
    'cloudformation',
    'list-stack-resources',
    '--stack-name',
    stackName,
  ])) as { StackResourceSummaries?: Parameters<typeof resourceOf>[0] };
  const tableName = resourceOf(resources, 'AWS::DynamoDB::Table', 'slwikipermissionstable');
  const bucket = resourceOf(resources, 'AWS::S3::Bucket', 'slwikicontentbucket');
  // `search-index.ts` reads the index from the environment when it loads.
  process.env.SEARCH_INDEX_ARN = resourceOf(resources, 'AWS::S3Vectors::Index', 'SearchIndex');
  const { writePage } = await import('../search-index.js');

  const s3 = new S3Client({});
  const spaces = await queryAll(tableName, [
    '--index-name',
    'gsi1',
    '--key-condition-expression',
    'gsi1pk = :pk',
    '--expression-attribute-values',
    JSON.stringify({ ':pk': { S: ALL_SPACES } }),
  ]);
  const spaceIds = spaces
    .filter((item) => item.sk?.S === META && item.pk?.S !== undefined)
    .map((item) => idOf(item.pk!.S!));

  let written = 0;
  for (const spaceId of spaceIds) {
    const items = await queryAll(tableName, [
      '--key-condition-expression',
      'pk = :pk AND begins_with(sk, :sk)',
      '--expression-attribute-values',
      JSON.stringify({ ':pk': { S: spacePk(spaceId) }, ':sk': { S: PAGE_SK_PREFIX } }),
    ]);
    for (const item of items) {
      // Folders carry no text and are not indexed.
      if (item.type?.S !== 'PAGE' || (item.kind?.S ?? 'page') !== 'page') continue;
      const bodyKey = item.bodyKey?.S;
      const object =
        bodyKey === undefined
          ? undefined
          : await s3.send(new GetObjectCommand({ Bucket: bucket, Key: bodyKey }));
      await writePage({
        spaceId,
        pageId: idOf(item.sk!.S!),
        title: item.title?.S ?? '',
        body: (await object?.Body?.transformToString('utf8')) ?? '',
      });
      written += 1;
    }
  }
  console.log(`Indexed ${written} pages in ${spaceIds.length} spaces.`);
}

await main();

import { deploy, getStackName } from '@aws-blocks/blocks/scripts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

/** The stack output holding the address readers open the Wiki at. */
const HOSTING_URL_OUTPUT = 'HostingHostingUrl';

/**
 * The address this deployment is reached at, read back from the stack that is
 * already running.
 *
 * Two settings need this address, and both go quiet when they do not get it.
 * `MCP_PUBLIC_ORIGIN` has to name the CloudFront distribution, because
 * CloudFront replaces the `Host` header on its way to the API and the Lambda
 * can no longer tell what the caller typed (`aws-blocks/mcp.ts`); without it
 * the stack deploys, the Wiki works, and only the OAuth metadata names an
 * endpoint nobody connected to. `CORS_ALLOWED_ORIGINS` has to name the origin
 * the browser loads the Wiki from, because attachments travel straight from
 * the browser to the bucket over a presigned URL (`aws-blocks/resources.ts`);
 * without it the deploy still succeeds and the refusal waits until someone
 * attaches a file.
 *
 * The value cannot be resolved inside the CDK app — the Lambda would depend on
 * the distribution, which depends on the API, which depends on the Lambda — so
 * it has to arrive from outside. Leaving that to whoever types the deploy
 * command means a step that is remembered until it isn't, and the deployment
 * that forgets it looks exactly like one that didn't. The stack itself already
 * knows the answer, so this asks the stack.
 *
 * Returns `null` only when there is no stack yet. That is the first deploy, and
 * the address genuinely does not exist until it finishes; the CDK app warns,
 * and the next deploy picks the address up.
 */
async function deployedHostingOrigin(): Promise<string | null> {
  const stackName = getStackName({ sandbox: false, projectRoot });
  const cloudFormation = new CloudFormationClient({});

  let stacks;
  try {
    ({ Stacks: stacks } = await cloudFormation.send(
      new DescribeStacksCommand({ StackName: stackName }),
    ));
  } catch (error) {
    if (isStackNotFound(error)) return null;
    throw error;
  }

  const outputs = stacks?.[0]?.Outputs ?? [];
  // CDK appends a hash to the output name, so this matches on the prefix. A
  // running stack always has the output; not finding it means the framework
  // renamed it, and failing here is the point — the alternative is deploying
  // without the origin and calling it success.
  const url = outputs.find((o) => o.OutputKey?.startsWith(HOSTING_URL_OUTPUT))?.OutputValue;
  if (url === undefined || url === '') {
    throw new Error(
      `Stack ${stackName} exists but has no ${HOSTING_URL_OUTPUT}* output. ` +
        'MCP_PUBLIC_ORIGIN cannot be resolved, and deploying without it would leave the ' +
        'MCP OAuth metadata naming the API Gateway URL. Pass MCP_PUBLIC_ORIGIN explicitly, ' +
        'or fix the output lookup in aws-blocks/scripts/deploy.ts.',
    );
  }
  return url.replace(/\/+$/, '');
}

/** CloudFormation's way of saying the stack has never been deployed. */
function isStackNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ValidationError' &&
    error.message.includes('does not exist')
  );
}

// An explicit value still wins, and each setting is decided on its own. Pointing
// a deployment at a custom domain is the case the lookup cannot serve: the stack
// knows its CloudFront address, not the name someone put in front of it. For
// `CORS_ALLOWED_ORIGINS` an explicit value also carries the case this cannot
// guess — it is a comma-separated list, and a deployment may serve the Wiki from
// somewhere the stack has never heard of.
const wantsMcpOrigin = (process.env.MCP_PUBLIC_ORIGIN ?? '') === '';
const wantsCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '') === '';

if (wantsMcpOrigin || wantsCorsOrigins) {
  const origin = await deployedHostingOrigin();
  if (origin !== null) {
    if (wantsMcpOrigin) {
      process.env.MCP_PUBLIC_ORIGIN = origin;
      console.log(`🔗 MCP_PUBLIC_ORIGIN resolved from the running stack: ${origin}`);
    }
    if (wantsCorsOrigins) {
      process.env.CORS_ALLOWED_ORIGINS = origin;
      console.log(`🔗 CORS_ALLOWED_ORIGINS resolved from the running stack: ${origin}`);
    }
  }
}

deploy({
  cdkAppPath: join(__dirname, '..', 'index.cdk.ts'),
  projectRoot,
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

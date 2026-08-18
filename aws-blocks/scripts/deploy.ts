import { deploy, getStackName } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { guardSsoChanges, readStackOutputs, resolveSso, ssoConfigured } from './sso-resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const stackName = getStackName({ sandbox: false, projectRoot });

/** The stack output holding the address readers open the Wiki at. */
const HOSTING_URL_OUTPUT = 'HostingHostingUrl';

/**
 * The address this deployment is reached at, from the stack's outputs.
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
 * it has to arrive from outside, and the stack itself already knows the answer.
 */
function hostingOrigin(outputs: Map<string, string>): string {
  // CDK appends a hash to the output name, so this matches on the prefix. A
  // running stack always has the output; not finding it means the framework
  // renamed it, and failing here is the point — the alternative is deploying
  // without the origin and calling it success.
  const url = [...outputs.entries()].find(([key]) => key.startsWith(HOSTING_URL_OUTPUT))?.[1];
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

// An explicit value still wins, and each setting is decided on its own. Pointing
// a deployment at a custom domain is the case the lookup cannot serve: the stack
// knows its CloudFront address, not the name someone put in front of it. For
// `CORS_ALLOWED_ORIGINS` an explicit value also carries the case this cannot
// guess — it is a comma-separated list, and a deployment may serve the Wiki from
// somewhere the stack has never heard of.
// The stub identity provider approves sign-ins without authenticating anybody
// and belongs to `pnpm run dev` alone. Cleared rather than merely not set, so
// that an ambient value left in a shell cannot reach a deployed stack — this
// runs before the CDK app is loaded, which is where `federation.ts` reads it.
delete process.env.SSO_STUB;

const wantsMcpOrigin = (process.env.MCP_PUBLIC_ORIGIN ?? '') === '';
const wantsCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '') === '';
const wantsResolvedOrigin = wantsMcpOrigin || wantsCorsOrigins;

/** Puts a resolved address into whichever of the two settings asked for one. */
function applyOrigin(origin: string): void {
  if (wantsMcpOrigin) {
    process.env.MCP_PUBLIC_ORIGIN = origin;
    console.log(`🔗 MCP_PUBLIC_ORIGIN resolved from the running stack: ${origin}`);
  }
  if (wantsCorsOrigins) {
    process.env.CORS_ALLOWED_ORIGINS = origin;
    console.log(`🔗 CORS_ALLOWED_ORIGINS resolved from the running stack: ${origin}`);
  }
}

function runDeploy(): Promise<unknown> {
  return deploy({
    cdkAppPath: join(__dirname, '..', 'index.cdk.ts'),
    projectRoot,
  });
}

try {
  const outputsBefore = await readStackOutputs(stackName);
  await guardSsoChanges(outputsBefore);

  // A stack that is already running knows its answers, so a normal deploy needs
  // one pass. `null`/`false` here mean the stack (or the SSO surface on it)
  // does not exist yet: this is the pass that creates it.
  const originBefore =
    wantsResolvedOrigin && outputsBefore !== null ? hostingOrigin(outputsBefore) : null;
  if (originBefore !== null) applyOrigin(originBefore);
  const ssoBefore = ssoConfigured() ? await resolveSso(stackName, outputsBefore) : true;

  await runDeploy();

  // The first pass created what the settings above needed, so it configured
  // the Lambda without them. Rather than leave the second pass to whoever
  // typed the command — a step that is remembered until it isn't — this asks
  // the stack that now exists and deploys again. Only the Lambda's
  // environment changes, so the pass is short. The conditions can only hold
  // once each: from here on the stack answers on the first ask.
  const needsSecondPass = (wantsResolvedOrigin && originBefore === null) || !ssoBefore;
  if (needsSecondPass) {
    const outputs = await readStackOutputs(stackName);
    if (outputs === null) {
      throw new Error(
        'The deploy reported success but the stack cannot be found, so the settings that ' +
          'needed its outputs are still unset. Run pnpm run deploy again, or pass ' +
          'MCP_PUBLIC_ORIGIN and CORS_ALLOWED_ORIGINS explicitly.',
      );
    }
    console.log(
      '\n🔁 First pass done: the values below existed only once the run above finished. ' +
        'Deploying once more to hand them to the Lambda. Later deploys take a single pass.',
    );
    if (wantsResolvedOrigin && originBefore === null) applyOrigin(hostingOrigin(outputs));
    if (!ssoBefore && !(await resolveSso(stackName, outputs))) {
      throw new Error(
        'sso.config.json names identity providers but the deploy produced no UserPoolIssuerUrl / ' +
          'SsoAuthClientId outputs, so the federation settings cannot be resolved. The stack ' +
          'and aws-blocks/index.cdk.ts disagree — fix that before deploying SSO.',
      );
    }
    await runDeploy();
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

import { startSandbox, getStackName } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readStackOutputs, resolveSso, ssoConfigured } from './sso-resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

// The stub identity provider approves sign-ins without authenticating anybody
// and belongs to `pnpm run dev` alone. Cleared rather than merely not set, so
// that an ambient value left in a shell cannot reach a deployed stack — this
// runs before the CDK app is loaded, which is where `federation.ts` reads it.
delete process.env.SSO_STUB;

// SSO against the sandbox stack, resolved the same way `deploy.ts` does it:
// the pool's issuer URL and the federation client's credentials are read off
// the stack that already exists. A sandbox has no second automated pass — the
// first run with `sso.config.json` entries creates the pool-side surface, and
// the values only become resolvable on the next run, so that is what the
// message asks for.
// Unlike `deploy.ts`, no removal or rename guard runs here — on purpose. A
// sandbox is disposable: setting `"sandbox": false` in the file tears its SSO
// surface down and flipping it back rebuilds it, and there are no federated
// users whose accounts a rename would orphan. The guards exist for the silent
// production breakages, and adding them here would make every SSO-less
// sandbox run demand a flag for a loss that costs nothing.
if (ssoConfigured({ sandbox: true })) {
  const stackName = getStackName({ sandbox: true, projectRoot });
  const resolved = await resolveSso(stackName, await readStackOutputs(stackName));
  if (!resolved) {
    console.log(
      '🔗 sso.config.json names identity providers, but this sandbox stack does not carry ' +
        'the SSO surface yet. This run creates it; stop the sandbox once it is up and run ' +
        '`pnpm run sandbox` again to activate federated sign-in.',
    );
  }
}

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts')
});

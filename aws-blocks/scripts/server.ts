import { startDevServer } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stand up the in-process stub identity provider, so federated sign-in can be
// exercised offline with no real IdP and no credentials. Only this script sets
// it: `sandbox.ts` and `deploy.ts` clear it before synth, and `federation.ts`
// refuses it inside Lambda. A deployment that has a real IdP configured uses
// that one instead — the stub is only reached when there is nothing else.
process.env.SSO_STUB = 'true';

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  frontendCommand: 'pnpm exec vite --port 3100 --strictPort',
  frontendPort: 3100,
});

/**
 * Resolution of the federation settings from a running stack.
 *
 * Turning SSO on is one operator decision (the `sso.config.json` entries,
 * each IdP's shape), but the runtime needs values that only exist once the stack does:
 * the pool's issuer URL, and each federation app client's id and secret.
 * Leaving them to whoever types the deploy command would be a step that is
 * remembered until it isn't, so both deploy scripts resolve them from the
 * stack and store the credentials where the runtime reads them (the
 * `sso-client-id*` / `sso-client-secret*` AppSettings in SSM). Shared between
 * `deploy.ts` and `sandbox.ts` because the two stacks differ only in name.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  ListIdentityProvidersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

import { ssoIdpEntries, ssoLogicalSuffix, ssoSettingIds } from '../sso-config.js';

/** Whether this deploy asks for any external IdP at all. */
export function ssoConfigured(options?: { sandbox?: boolean }): boolean {
  return ssoIdpEntries(options).length > 0;
}

/**
 * The named stack's outputs, or `null` when there is no stack yet.
 *
 * `null` is a real answer, not an error: on the first deploy the values being
 * asked for genuinely do not exist until the deploy finishes, and the caller
 * asks again once it has.
 */
export async function readStackOutputs(stackName: string): Promise<Map<string, string> | null> {
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
  const outputs = new Map<string, string>();
  for (const output of stacks?.[0]?.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs.set(output.OutputKey, output.OutputValue);
    }
  }
  return outputs;
}

/** CloudFormation's way of saying the stack has never been deployed. */
function isStackNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ValidationError' &&
    error.message.includes('does not exist')
  );
}

/**
 * Resolves `SSO_ISSUER_URL` and stores the federation-client credentials of
 * every entry the stack already carries. Returns whether *all* entries were
 * served — `false` asks the caller for a second pass, which is how the deploy
 * that enables SSO, or adds an entry, gets its new client created and then
 * resolved.
 *
 * The entries that already exist are resolved even when others are missing.
 * This is not an optimisation but a safety rule: `SSO_ISSUER_URL` is what
 * makes the synth declare the AuthOIDC surface at all, so a deploy that adds
 * a second IdP to a stack whose first one is live must keep the issuer set on
 * its first pass — an all-or-nothing answer would synth that pass with no
 * providers, tear the running SSO surface out of the stack, and strand its
 * session table as an orphan the second pass then collides with.
 */
export async function resolveSso(
  stackName: string,
  outputs: Map<string, string> | null,
): Promise<boolean> {
  const entries = ssoIdpEntries();
  const issuerUrl = outputs?.get('UserPoolIssuerUrl');
  if (issuerUrl === undefined) return false;
  const clientIds = entries.map((entry) => ({
    entry,
    clientId: outputs?.get(`SsoAuthClientId${ssoLogicalSuffix(entry)}`),
  }));
  const present = clientIds.filter(
    (candidate): candidate is { entry: (typeof candidate)['entry']; clientId: string } =>
      candidate.clientId !== undefined,
  );
  // No SSO surface on the stack at all: the first SSO-enabling pass. There is
  // nothing to keep alive, so nothing is resolved and the issuer stays unset.
  if (present.length === 0) return false;

  const poolId = issuerUrl.slice(issuerUrl.lastIndexOf('/') + 1);
  const cognito = new CognitoIdentityProviderClient({});
  const ssm = new SSMClient({});
  for (const { entry, clientId } of present) {
    const { UserPoolClient: client } = await cognito.send(
      new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: clientId }),
    );
    const secret = client?.ClientSecret;
    if (secret === undefined || secret === '') {
      throw new Error(
        `The federation app client ${clientId} (${entry.providerName}) has no secret. It is ` +
          'created with `generateSecret: true` (aws-blocks/index.cdk.ts), so this means the ' +
          'client was replaced by something that does not match — fix the stack before ' +
          'deploying SSO.',
      );
    }

    // The AppSetting parameter names, as `@aws-blocks/bb-app-setting` derives
    // them: `/<stack>-<scope path>`. Hardcoding the `sl-wiki` scope segment is
    // accepted — it is as fixed as the AppSetting ids themselves, and a rename
    // would already be a new parameter. The derivation rule itself is the
    // shakier dependency: the block's README does not document it, so this
    // spelling is mimicry of observed behaviour, and a block update that
    // changes it would break nothing visibly here — the deploy would succeed
    // and write parameters the runtime never reads, and the symptom would be
    // federated sign-in failing for no stated reason. If SSO breaks right
    // after a `@aws-blocks/*` update, check these names against what the
    // runtime resolves first.
    //
    // Written on every SSO deploy, not only the first: the values are wholly
    // owned by the stack (nobody rotates them by hand), so rewriting keeps
    // them correct across a client replacement. JSON-encoded because that is
    // the format `AppSetting.get()` parses.
    const ids = ssoSettingIds({ name: entry.providerName, primary: entry.primary });
    for (const [name, value] of [
      [`/${stackName}-sl-wiki-${ids.clientId}`, clientId!],
      [`/${stackName}-sl-wiki-${ids.clientSecret}`, secret],
    ] as const) {
      try {
        await ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: JSON.stringify(value),
            Type: 'SecureString',
            Overwrite: true,
          }),
        );
      } catch (error) {
        // The writes are not atomic, so failing between them can leave a
        // stored id and secret disagreeing — federated sign-in fails until
        // both are rewritten. Every SSO deploy rewrites all of them, so the
        // recovery is simply running the deploy again, and the error has to
        // say so: the operator reading it has no other way to know the fix is
        // that cheap.
        throw new Error(
          `Storing the federation client credentials failed at ${name}. The ids and secrets ` +
            'are written one after the other, so a stored pair may now disagree and federated ' +
            'sign-in may fail. Re-run the deploy — every SSO deploy rewrites all of them.',
          { cause: error },
        );
      }
    }
    console.log(
      `🔗 SSO client credentials stored (/${stackName}-sl-wiki-${ids.clientId}, …-secret)`,
    );
  }

  process.env.SSO_ISSUER_URL = issuerUrl;
  console.log(`🔗 SSO_ISSUER_URL resolved from the running stack: ${issuerUrl}`);
  // The group claim arrives inside a Cognito ID token, where each identity
  // provider registration copied its own claim into the pool's one custom
  // attribute — so the runtime reads a single name whatever the IdP.
  if ((process.env.SSO_GROUPS_CLAIM ?? '').trim() === '') {
    process.env.SSO_GROUPS_CLAIM = 'custom:groups';
  }
  // Entries whose clients do not exist yet are the second pass's work.
  return present.length === entries.length;
}

/**
 * Refuses a deploy that would rename or remove identity provider
 * registrations without being told to.
 *
 * Both mistakes are quiet and expensive. A registration's name prefixes every
 * federated username (`<name>_<sub>`), so a rename renames nobody: Cognito
 * creates a fresh account for each federated user on their next sign-in, and
 * the old accounts — with every permission edge and directory record pointing
 * at them — are orphaned. A removal kills every session of that IdP's users
 * and 500s their sign-in button. The deploy itself reports success either
 * way, which is why the mistake has to be caught here, before the stack
 * moves.
 *
 * The comparison is by name: whatever the pool has registered that the
 * config file's entries no longer name is about to disappear. A deliberate
 * change says so — `SSO_REMOVE=true` removes everything (the no-entries
 * deploy), `SSO_REMOVE=<name>[,<name>]` removes the named registrations. A
 * rename is a removal of the old name plus an addition of the new one, so
 * `SSO_REMOVE=<old name>` is also how a rename is confirmed.
 *
 * Only a stack already carrying the SSO surface is checked: on the first SSO
 * deploy there is nothing to lose.
 */
export async function guardSsoChanges(outputs: Map<string, string> | null): Promise<void> {
  const entries = ssoIdpEntries();
  const hadSso = outputs?.has('SsoAuthClientId') ?? false;

  if (entries.length === 0) {
    if (hadSso && process.env.SSO_REMOVE !== 'true') {
      throw new Error(
        'This stack has SSO configured, but sso.config.json names no identity provider. ' +
          'Deploying now would remove every identity provider registration and break federated ' +
          'sign-in. Restore the entries (see docs/runbooks/external-idp-federation.md), ' +
          'or set SSO_REMOVE=true to remove SSO deliberately.',
      );
    }
    return;
  }

  const issuerUrl = outputs?.get('UserPoolIssuerUrl');
  if (issuerUrl === undefined || !hadSso) return;

  const poolId = issuerUrl.slice(issuerUrl.lastIndexOf('/') + 1);
  const cognito = new CognitoIdentityProviderClient({});
  const { Providers: providers = [] } = await cognito.send(
    new ListIdentityProvidersCommand({ UserPoolId: poolId, MaxResults: 60 }),
  );
  const registered = providers
    .map((provider) => provider.ProviderName)
    .filter((name): name is string => name !== undefined);
  const configured = new Set(entries.map((entry) => entry.registrationName));
  const missing = registered.filter((name) => !configured.has(name));
  if (missing.length === 0) return;

  if (process.env.SSO_REMOVE === 'true') return;
  const allowed = new Set(
    (process.env.SSO_REMOVE ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  const leftover = missing.filter((name) => !allowed.has(name));
  if (leftover.length === 0) return;

  throw new Error(
    `The pool has identity providers registered as "${leftover.join('", "')}", and ` +
      `sso.config.json names "${[...configured].join('", "')}" — the rest would be ` +
      'deleted. If a provider was renamed, note that renaming renames nobody: federated ' +
      'usernames keep the old name as their prefix, so every one of that IdP\'s users would ' +
      'get a fresh account with no permissions, and any role-group mapping naming the old ' +
      'provider goes stale. To remove the named registrations deliberately (a rename included ' +
      `— it removes the old name), pass SSO_REMOVE=${leftover.join(',')}.`,
  );
}

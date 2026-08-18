import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';

import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getStackName } from '@aws-blocks/blocks/scripts';

import {
  ssoCallbackOriginsFromConfig,
  ssoIdpEntries,
  ssoLogicalSuffix,
  ssoProvidersJson,
  ssoSecretName,
} from './sso-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });

// ─── Search corpus bucket name ───────────────────────────────────────────────
// The KnowledgeBase block reads the corpus from an s3:// source whose bucket name
// must be a concrete string at synth (it parses the URI) — a block-generated name
// is a deferred token, so the bucket is created here with a name fixed now. The
// name is handed to `resources.ts` through the environment *before* the backend
// is imported below, so the block sees the s3:// source. The same name is
// injected into the handler further down.
//
// The name is a digest of the stack, the account, and the region. All three
// belong in it: S3 bucket names are unique across every AWS account, so a name
// that only says "sl-wiki" would be taken by whoever deployed first, and a name
// that omits the stack would put every stack in one account — a sandbox and the
// long-running deployment, or two developers' sandboxes — on the same bucket.
// Only the first one to deploy would get it; the rest fail at the change set
// with "already exists". A digest rather than the values themselves keeps the
// account id out of a name that is read from the deploy environment and never
// committed, and keeps the length inside the 63-character limit.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
if (!account || !region) {
  throw new Error(
    'The search corpus bucket name needs CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION. ' +
      'Deploy through `pnpm run sandbox` / `pnpm run deploy` with AWS credentials.',
  );
}
const corpusBucketName = `sl-wiki-search-corpus-${createHash('sha256')
  .update(`${stackName}:${account}:${region}`)
  .digest('hex')
  .slice(0, 16)}`;
process.env.SEARCH_CORPUS_BUCKET = corpusBucketName;

// ─── External identity providers: the configured entries ─────────────────────
// Parsed once, before the backend import below, because `federation.ts` runs
// during that import and reads `SSO_PROVIDERS` to declare one sign-in provider
// per entry. The registration of each IdP on the pool sits further down,
// beside the pool it registers on.
const ssoEntries = ssoIdpEntries({ sandbox: sandboxMode });
if (ssoEntries.length > 0) {
  process.env.SSO_PROVIDERS = ssoProvidersJson(ssoEntries);
}

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

if (sandboxMode) {
  // Make all resources deletable so sandbox:destroy can clean up the entire stack.
  // This overrides removal policies and deletion protection (e.g. RDS) for every
  // resource in the stack, including any you add below.
  // Remove these lines if you want to manage teardown behavior yourself.
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

// ─── Search corpus bucket + re-ingestion grant ───────────────────────────────
// The corpus bucket the KnowledgeBase block imports as its s3:// source. It is
// created here (not by the block) because its name had to be fixed at synth, and
// because the app writes to it at runtime, which a block-created source bucket is
// not set up for. The block only reads it; the handler reads and writes it.
const corpusBucket = new cdk.aws_s3.Bucket(blocksStack, 'SearchCorpus', {
  bucketName: corpusBucketName,
  blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
  encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  // Match the content bucket / the block's own removal rule: droppable in a
  // sandbox, retained otherwise so a real deployment never loses its corpus.
  removalPolicy: sandboxMode ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
  autoDeleteObjects: sandboxMode,
});
corpusBucket.grantReadWrite(blocksStack.handler);
blocksStack.handler.addEnvironment('SEARCH_CORPUS_BUCKET', corpusBucketName);

// ─── Keyword index bucket name ───────────────────────────────────────────────
// The keyword-search index lives in the content FileBucket, one object per
// space under `search-index/`. The runtime reads and writes those objects with
// the plain S3 SDK rather than the block API, because its freshness check is
// `HeadObject`+ETag, which the block does not expose. The SDK needs the
// bucket's physical name; the handler's read/write permission already exists
// through the block's own grant. The bucket construct is found by walking the
// tree, like the knowledge base above — matched exhaustively so a second
// bucket with "content" in its path fails the synth rather than silently
// receiving the index.
const contentBuckets = blocksStack.node
  .findAll()
  .filter((node): node is cdk.aws_s3.Bucket => node instanceof cdk.aws_s3.Bucket)
  .filter((bucket) => bucket.node.path.includes('content'));
if (contentBuckets.length !== 1) {
  throw new Error(
    `Expected exactly one content bucket for the keyword index, found ${contentBuckets.length}.`,
  );
}
blocksStack.handler.addEnvironment('KEYWORD_INDEX_BUCKET', contentBuckets[0]!.bucketName);

// ─── Conversation model ──────────────────────────────────────────────────────
// The Agent block resolves its model where it runs, not where it is synthesized:
// the CDK side provisions the tables, bucket, queue and WebSocket and never looks
// at `model`, while the runtime constructor picks it up from the config built
// during the handler's own import. So `AI_MODEL_ID` has to reach the Lambda's
// environment — reading it at synth alone would leave every deploy on the
// default, silently, no matter what the operator passed.
const modelId = process.env.AI_MODEL_ID;
if (modelId !== undefined && modelId !== '') {
  blocksStack.handler.addEnvironment('AI_MODEL_ID', modelId);
}

// `StartIngestionJob` is the one Bedrock call the block does not wrap and does not
// grant (it grants Retrieve / Get- / ListIngestionJob). The re-ingestion job calls
// it directly, so the permission is added here, scoped to the block's own
// knowledge base. The KB construct is found by walking the tree the backend import
// built — the block exposes no handle to it.
const knowledgeBase = blocksStack.node
  .findAll()
  .find(
    (node): node is cdk.aws_bedrock.CfnKnowledgeBase =>
      node instanceof cdk.aws_bedrock.CfnKnowledgeBase,
  );
if (knowledgeBase === undefined) {
  throw new Error('Expected a Bedrock knowledge base in the stack for the re-ingestion grant.');
}
blocksStack.handler.addToRolePolicy(
  new cdk.aws_iam.PolicyStatement({
    actions: ['bedrock:StartIngestionJob'],
    resources: [knowledgeBase.attrKnowledgeBaseArn],
  }),
);

// ─── External identity provider: what the runtime reads ──────────────────────
// `federation.ts` reads these when it decides whether to declare an OIDC
// provider, and that decision is made twice: once here during synth, which is
// what creates the sign-in routes, and once in the Lambda, which is what serves
// them. Both readings must agree, so whatever the deploy script resolved is
// forwarded into the function's environment. `SSO_ISSUER_URL` names this
// stack's own user pool — the deploy scripts derive it from the pool id — and
// the registration that puts the external IdP behind that pool sits further
// down, beside the pool it registers on.
//
// The credentials are not here. They live in SSM as `AppSetting`s the runtime
// resolves, so rotating them is a parameter write rather than a deploy.
for (const name of ['SSO_ISSUER_URL', 'SSO_PROVIDERS', 'SSO_GROUPS_CLAIM', 'SSO_SCOPES']) {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== '') {
    blocksStack.handler.addEnvironment(name, value.trim());
  }
}

// `SSO_STUB` is deliberately not forwarded, and must never be. It stands up an
// in-process identity provider that approves sign-ins without authenticating
// anybody — a way in for whoever can reach it. `federation.ts` refuses it
// inside Lambda as well; this is the other half of the same rule, placed where
// somebody adding a variable to the loop above would have to read it.

// ─── MCP server: the Cognito OAuth surface ───────────────────────────────────
// The MCP server itself is a `RawRoute` on this same Lambda and needs nothing
// here. What it does need is a user pool that can act as an OAuth authorization
// server, and AuthCognito deliberately builds one that cannot: its app client
// is `disableOAuth`, and it creates no sign-in domain, because the block hands
// the browser an opaque session cookie rather than Cognito's tokens.
// None of that is undone below — a second app client is added alongside, for
// external AI clients only.
//
// The pool is found by walking the tree, as the knowledge base above is. The
// block does expose `userPool` on its CDK class, but reaching it would mean
// importing `resources.ts` here, and that import resolves to the block's
// *runtime* class under `tsc --noEmit` (the CDK class is behind an export
// condition the type check does not apply), so the handle would not type.
// Matched exhaustively rather than by first hit: a second pool appearing in the
// tree later would otherwise get the OAuth surface silently, and which one it
// landed on would be an accident of construction order.
const userPools = blocksStack.node
  .findAll()
  .filter((node): node is cdk.aws_cognito.UserPool => node instanceof cdk.aws_cognito.UserPool);
if (userPools.length !== 1) {
  throw new Error(
    `Expected exactly one Cognito user pool for the MCP OAuth surface, found ${userPools.length}.`,
  );
}
const userPool = userPools[0]!;

/**
 * The loopback port the MCP client is redirected back to after sign-in.
 *
 * Fixed, because Cognito matches redirect URIs exactly and they are registered
 * at deploy time; a client picking a random port would never match. This is the
 * value the operator passes as `--callback-port`.
 */
const MCP_CALLBACK_PORT = 33418;

/**
 * Where the Obsidian sync plugin is redirected back to after sign-in.
 *
 * A custom URI scheme rather than a loopback port. Obsidian registers
 * `obsidian://` with the operating system and lets a plugin claim one action
 * under it, so the browser's redirect reopens Obsidian and hands the
 * authorization code straight to the plugin — with no local HTTP server to
 * stand up, which is what a loopback redirect would need and what mobile
 * Obsidian has no way to provide.
 *
 * Cognito accepts a custom scheme here; only `http` is restricted (to
 * loopback). The plugin's own protocol handler must register this exact action
 * name, because Cognito matches redirect URIs whole.
 */
const OBSIDIAN_CALLBACK_URL = 'obsidian://slwiki-auth';

// The prefix of the hosted sign-in domain, `<prefix>.auth.<region>.amazoncognito.com`.
//
// That name space is shared by every AWS account in the region, so the stack
// name alone is not enough — `sl-wiki-…` is exactly the kind of name another
// account would also pick, and the collision surfaces as a deploy failure. A
// short digest of the account id disambiguates it. The digest, not the account
// id itself: the prefix is visible in the sign-in URL every user sees, and this
// repository is public (`CLAUDE.md`).
//
// Cognito also reserves `aws`, `amazon` and `cognito` anywhere in the prefix —
// the same class of naming trap that failed this project's first deploy, so it
// is refused here, at synth, rather than as a deploy error twenty minutes in.
const accountDigest = createHash('sha256').update(account).digest('hex').slice(0, 8);
const mcpDomainPrefix = `${stackName}-${accountDigest}`
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 63);
for (const reserved of ['aws', 'amazon', 'cognito']) {
  if (mcpDomainPrefix.includes(reserved)) {
    throw new Error(
      `The Cognito sign-in domain prefix "${mcpDomainPrefix}" contains the reserved word ` +
        `"${reserved}". Rename the stack (\`.blocks/config.json\`) or the sandbox id.`,
    );
  }
}
const mcpDomain = userPool.addDomain('McpSignInDomain', {
  // The classic hosted UI, not managed login. Managed login additionally needs a
  // branding style resource and an `essentials` feature plan; the sign-in screen
  // is not what this decision is about, so the version that works on any plan
  // with no extra resource is the one used.
  cognitoDomain: { domainPrefix: mcpDomainPrefix },
});
// One domain, two doors. Besides the MCP OAuth flow it is named for, this
// domain is what the pool's OIDC discovery document publishes as its
// authorization and token endpoints — which is what lets the AuthOIDC block in
// `federation.ts` point at the pool as an ordinary OIDC issuer. The external
// IdP registration below rides on it too: the IdP redirects back to
// `<domain>/oauth2/idpresponse`.

// ─── External identity provider: registration on the pool ───────────────────
// The company IdP — Entra, Okta, OneLogin — is registered *on the pool*, not
// talked to by the application. Sign-in flows browser → pool hosted UI → IdP →
// back to the pool (which creates the federated account as a pool user) → the
// AuthOIDC callback. That is what makes a federated user a Cognito user: MCP
// and `/ext/*` Bearer auth work for them unchanged, and every identifier is
// the pool's `sub`.
//
// Everything here describes the IdP's shape and is deploy-time, like
// `SSO_ISSUER_URL` above. The one secret — the IdP's client secret — never
// touches the template: CloudFormation resolves it at deploy through a
// dynamic reference, so the operator writes it once and no file ever carries
// it. Secrets Manager, not the `ssm-secure` reference every other secret here
// uses, because CloudFormation only honours `ssm-secure` on a short list of
// resources that does not include `UserPoolIdentityProvider` — it would store
// the literal `{{resolve:...}}` text as the client secret and fail only at
// sign-in. A `secretsmanager` reference works in any property, at the cost of
// one $0.40/month secret that exists only while SSO does.
// One registration and one app client per entry. The client is what keeps the
// hosted UI from drawing its chooser: a client whose
// `supportedIdentityProviders` names a single IdP forwards straight to it, so
// each provider gets a client of its own and every sign-in goes direct. The
// entries came from `ssoIdpEntries()` above; the primary entry keeps the
// logical ids, names and outputs of the single-IdP days, which is what lets a
// running deployment take this change with an empty diff.
const ssoRegistrations = ssoEntries.map((entry) => {
  const suffix = ssoLogicalSuffix(entry);
  const idp = new cdk.aws_cognito.UserPoolIdentityProviderOidc(blocksStack, `SsoIdp${suffix}`, {
    userPool,
    // The registration name becomes part of federated usernames
    // (`<name>_<sub>`), so changing it later orphans every federated account —
    // pick once.
    name: entry.registrationName,
    clientId: entry.clientId,
    // The secret name matches the AppSetting naming convention
    // (`<stack>-sl-wiki-…`) so the operator finds all of a stack's SSO secrets
    // by one prefix. Not an AppSetting itself: the runtime never reads it,
    // only CloudFormation does.
    clientSecret: `{{resolve:secretsmanager:${ssoSecretName(entry, stackName)}}}`,
    issuerUrl: entry.issuerUrl,
    scopes: entry.scopes,
    attributeMapping: {
      // Email is the pool's sign-in identifier and display address, so the
      // federated account must carry one from its first sign-in.
      email: cdk.aws_cognito.ProviderAttribute.other('email'),
      custom: {
        // Whatever the IdP calls its group claim, it lands in the one custom
        // attribute the runtime reads — the per-IdP difference ends here.
        'custom:groups': cdk.aws_cognito.ProviderAttribute.other(entry.groupsClaim),
      },
    },
  });

  // The app client the AuthOIDC block signs this entry's users in through.
  // Confidential (`generateSecret`) because the pool's token endpoint refuses
  // public clients with no PKCE, and the block is a server-side caller that
  // can hold a secret — the deploy script reads the generated value back and
  // stores it as the entry's `sso-client-id*` / `sso-client-secret*`
  // AppSettings the runtime resolves.
  //
  // `supportedIdentityProviders` names only this entry's IdP, deliberately
  // omitting `COGNITO`: password accounts keep signing in through the app's
  // own form (`AuthCognito`), never this client.
  const callbackUrls = sandboxMode
    ? // The sandbox front door: the frontend runs on localhost and proxies
      // `/aws-blocks/*` to the deployed API, so this is the origin the
      // callback comes back to.
      ['http://localhost:3000/aws-blocks/auth/callback']
    : ssoCallbackOrigins().map((origin) => `${origin}/aws-blocks/auth/callback`);
  const client = userPool.addClient(`SsoAuthClient${suffix}`, {
    userPoolClientName: entry.primary ? 'sl-wiki-sso' : `sl-wiki-sso-${entry.providerName}`,
    generateSecret: true,
    authFlows: {
      user: false,
      userPassword: false,
      userSrp: false,
      custom: false,
      adminUserPassword: false,
    },
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [
        cdk.aws_cognito.OAuthScope.OPENID,
        cdk.aws_cognito.OAuthScope.EMAIL,
        cdk.aws_cognito.OAuthScope.PROFILE,
      ],
      callbackUrls,
    },
    supportedIdentityProviders: [
      cdk.aws_cognito.UserPoolClientIdentityProvider.custom(entry.registrationName),
    ],
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
    accessTokenValidity: cdk.Duration.hours(1),
    // Matches the AuthOIDC session's own 30-day horizon — a refresh token that
    // outlives the session it serves would just be an unusable credential.
    refreshTokenValidity: cdk.Duration.days(30),
  });
  // `custom()` above is a plain string to CloudFormation, so nothing tells it
  // the client needs the IdP to exist first. Without this the first deploy
  // races and fails on "provider does not exist".
  client.node.addDependency(idp);
  return { entry, idp, client, suffix };
});

/**
 * The origins whose `/aws-blocks/auth/callback` the pool may redirect back to.
 *
 * Cognito matches redirect URIs exactly, so the deployed origin must be known
 * at synth. The deploy script resolves it from the running stack (the same
 * lookup that fills `MCP_PUBLIC_ORIGIN`), and the file's `callbackOrigins`
 * exists for the case the lookup cannot serve — a custom domain in front, or
 * a developer registering `http://localhost:3000` to run the flow locally.
 */
function ssoCallbackOrigins(): string[] {
  const explicit = ssoCallbackOriginsFromConfig();
  if (explicit.length > 0) return explicit;
  const resolved = (process.env.MCP_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (resolved !== '') return [resolved];
  throw new Error(
    'SSO is configured (sso.config.json) but no callback origin is known. The deploy script ' +
      'resolves one from the running stack; deploying a brand-new stack with SSO in the same ' +
      'command is the one case it cannot serve. Deploy once with the idps emptied, then again ' +
      'with them — or set callbackOrigins in sso.config.json explicitly.',
  );
}

const mcpReadScope = new cdk.aws_cognito.ResourceServerScope({
  scopeName: 'read',
  scopeDescription: 'Search the Wiki and read pages',
});
const mcpWriteScope = new cdk.aws_cognito.ResourceServerScope({
  scopeName: 'write',
  scopeDescription: 'Create, update and delete pages',
});
// `slwiki` is the audience half of the token check: Cognito access tokens carry
// no `aud`, so the pair (`client_id`, `scope`) is what tells the server a token
// was issued for it and not for something else on the same pool.
const mcpResourceServer = userPool.addResourceServer('McpResourceServer', {
  identifier: 'slwiki',
  userPoolResourceServerName: 'sl-wiki MCP',
  scopes: [mcpReadScope, mcpWriteScope],
});

// A public client: no secret, authorization code with PKCE, and no direct
// authentication flow — the only way to a token is through the browser and the
// pool's own sign-in screen.
//
// Every flow has to be named and refused explicitly. Leaving `authFlows` out
// emits no `ExplicitAuthFlows` at all, and Cognito's own default for that is
// SRP and custom-challenge authentication *enabled* — the opposite of what the
// sentence above claims. Spelling them out is what makes it true.
const mcpClient = userPool.addClient('McpClient', {
  userPoolClientName: 'sl-wiki-mcp',
  generateSecret: false,
  authFlows: {
    user: false,
    userPassword: false,
    userSrp: false,
    custom: false,
    adminUserPassword: false,
  },
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [
      cdk.aws_cognito.OAuthScope.resourceServer(mcpResourceServer, mcpReadScope),
      cdk.aws_cognito.OAuthScope.resourceServer(mcpResourceServer, mcpWriteScope),
    ],
    // One app client, three registered redirects, because the two clients that
    // use it differ only in how they get the code back. Both spellings of
    // loopback are there because RFC 8252 tells a native client to accept
    // either, and which one it builds is not ours to choose.
    callbackUrls: [
      `http://localhost:${MCP_CALLBACK_PORT}/callback`,
      `http://127.0.0.1:${MCP_CALLBACK_PORT}/callback`,
      OBSIDIAN_CALLBACK_URL,
    ],
  },
  // Named explicitly rather than left to CDK's auto-detection, whose answer
  // depends on construct order. `COGNITO` serves password accounts; the
  // external IdP entries are what let a federated user authorize an MCP client
  // at the same hosted screen. With more than one entry the hosted UI draws
  // its chooser here — accepted, because MCP sign-in runs on the classic
  // hosted UI anyway and the chooser is the only way to say which IdP.
  supportedIdentityProviders: [
    cdk.aws_cognito.UserPoolClientIdentityProvider.COGNITO,
    ...ssoRegistrations.map(({ entry }) =>
      cdk.aws_cognito.UserPoolClientIdentityProvider.custom(entry.registrationName),
    ),
  ],
  preventUserExistenceErrors: true,
  enableTokenRevocation: true,
  accessTokenValidity: cdk.Duration.hours(1),
  refreshTokenValidity: cdk.Duration.days(30),
});
for (const { idp } of ssoRegistrations) mcpClient.node.addDependency(idp);

blocksStack.handler.addEnvironment('MCP_USER_POOL_ID', userPool.userPoolId);
blocksStack.handler.addEnvironment('MCP_CLIENT_ID', mcpClient.userPoolClientId);
blocksStack.handler.addEnvironment('MCP_AUTH_DOMAIN', mcpDomain.baseUrl());

// The address clients actually reach, when the request cannot say what it is.
// Required whenever anything fronts the API — CloudFront does, and it replaces
// the `Host` header with the API Gateway's own domain, so the OAuth metadata
// would otherwise name an endpoint nobody connected to (see `mcp.ts`). It
// cannot be read off the distribution here: that would make the Lambda depend
// on the distribution which depends on the API which depends on the Lambda.
const publicOrigin = process.env.MCP_PUBLIC_ORIGIN;
if (publicOrigin !== undefined && publicOrigin !== '') {
  blocksStack.handler.addEnvironment('MCP_PUBLIC_ORIGIN', publicOrigin);
} else if (!sandboxMode) {
  // Not fatal: the rest of the Wiki works, and on the first deploy this is
  // expected — the distribution does not exist yet, and `scripts/deploy.ts`
  // deploys a second time with the address as soon as it does. Only MCP
  // discovery is affected, and it fails in a way that is hard to read
  // backwards, so it is called out here.
  console.warn(
    '[sl-wiki] MCP_PUBLIC_ORIGIN is not set. Until it is, the MCP OAuth metadata names the API ' +
      'Gateway URL rather than the CloudFront/custom domain, and MCP clients fail to connect. ' +
      'On the first deploy `pnpm run deploy` fills this in on its own second pass; for a custom ' +
      'domain, re-deploy with MCP_PUBLIC_ORIGIN=https://<your domain>.',
  );
}

// The client id and the domain prefix differ per deployment and must not be
// committed (`CLAUDE.md`), so the registration command is assembled from the
// deploy output rather than written down anywhere.
new cdk.CfnOutput(blocksStack, 'McpClientId', {
  value: mcpClient.userPoolClientId,
  description: 'client_id to pass to an MCP client as --client-id',
});
new cdk.CfnOutput(blocksStack, 'McpSignInDomain', {
  value: mcpDomain.baseUrl(),
  description: 'Cognito hosted sign-in domain backing the MCP OAuth flow',
});
new cdk.CfnOutput(blocksStack, 'McpCallbackPort', {
  value: String(MCP_CALLBACK_PORT),
  description: 'Loopback port to pass to an MCP client as --callback-port',
});
new cdk.CfnOutput(blocksStack, 'ObsidianCallbackUrl', {
  value: OBSIDIAN_CALLBACK_URL,
  description: 'Redirect URI the Obsidian sync plugin must register',
});

// Unconditional, though only federation reads it: the deploy script derives
// `SSO_ISSUER_URL` from this output *before* the SSO-enabling deploy runs, so
// it has to be on the stack already by the time an operator turns SSO on.
new cdk.CfnOutput(blocksStack, 'UserPoolIssuerUrl', {
  value: userPool.userPoolProviderUrl,
  description: 'The pool as an OIDC issuer — what the deploy script sets SSO_ISSUER_URL to',
});
for (const { entry, client, suffix } of ssoRegistrations) {
  new cdk.CfnOutput(blocksStack, `SsoAuthClientId${suffix}`, {
    value: client.userPoolClientId,
    description: `Federation app client (${entry.providerName}) — the deploy script stores its credentials as AppSettings`,
  });
}
if (ssoRegistrations.length > 0) {
  // One value for every IdP: the redirect target is the pool, not the entry.
  new cdk.CfnOutput(blocksStack, 'SsoIdpRedirectUri', {
    value: `${mcpDomain.baseUrl()}/oauth2/idpresponse`,
    description: 'Redirect URI to register at the external IdP',
  });
}

// Add static site hosting only when deploying (not in sandbox mode)
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'pnpm run build',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}
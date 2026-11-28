/**
 * The entry guard's CDK pieces: a CloudFront web ACL that narrows who reaches
 * the front door, and an origin-verify secret that makes the API Gateway
 * stage refuse every call that did not come through CloudFront.
 *
 * Why a shared secret for the stage: CloudFront origin access control does not
 * cover API Gateway, and CloudFront's own origin is the stage's
 * `execute-api` host, so the stage cannot be turned off. CloudFront therefore
 * adds a random value as the `Referer` origin custom header (replacing any
 * viewer `Referer`), and the stage's resource policy denies any request whose
 * `Referer` differs. This is the pattern `@aws-cdk-blocks/hosting` uses for
 * its server-rendering origins ("Origin-verify secret"); AWS CDK Blocks has no
 * setting for its shared API origin, so the distribution and the REST API are
 * adjusted here after `Hosting` has built them.
 *
 * Nothing here decides who may read what. Everything behind the guard still
 * requires a signed-in user and the per-space permission checks.
 */
import * as cdk from 'aws-cdk-lib';

import { MCP_PATHS, type EntryGuardConfig } from './entry-guard-config.js';

/**
 * The web ACL for the CloudFront distribution, in its own us-east-1 stack —
 * CloudFront web ACLs can live nowhere else, and the application stack is in
 * another region.
 *
 * One rule refuses (or, in `count` mode, counts) every request that is from
 * none of the allowed countries and is not an Anthropic-range request to one
 * of the MCP paths; another limits each source IP. Written as refusing rules
 * over an allowing default so that `count` mode is the same ACL with a
 * different action. No AWS managed rule groups: the common rule set refuses
 * request bodies over 8 KB, which would break saving a long page.
 */
export function createFrontDoorWebAcl(stack: cdk.Stack, config: EntryGuardConfig): { webAclArn: string } {
  const action = config.mode === 'block' ? { block: {} } : { count: {} };
  const visibility = (metricName: string) => ({
    cloudWatchMetricsEnabled: true,
    metricName,
    // Sampled requests keep every header unredacted, including the viewer's
    // cookies and MCP bearer tokens; the logs below redact them instead.
    sampledRequestsEnabled: false,
  });

  const geo = { geoMatchStatement: { countryCodes: config.allowCountries } };
  let allowed: Record<string, unknown> = geo;
  if (config.claudeAiRanges.length > 0) {
    const ranges = new cdk.aws_wafv2.CfnIPSet(stack, 'ClaudeAiRanges', {
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: config.claudeAiRanges,
      // WAF descriptions allow letters, digits, spaces and `+=:#@/-,.` only.
      description: 'Anthropic published outbound ranges for claude.ai connectors',
    });
    const mcpPath = {
      orStatement: {
        statements: MCP_PATHS.map((path) => ({
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: 'EXACTLY',
            searchString: path,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        })),
      },
    };
    allowed = {
      orStatement: {
        statements: [
          geo,
          { andStatement: { statements: [{ ipSetReferenceStatement: { arn: ranges.attrArn } }, mcpPath] } },
        ],
      },
    };
  }

  const webAcl = new cdk.aws_wafv2.CfnWebACL(stack, 'FrontDoorWebAcl', {
    scope: 'CLOUDFRONT',
    defaultAction: { allow: {} },
    description: 'sl-wiki entry guard: allowed countries, plus claude.ai on the MCP paths',
    visibilityConfig: visibility('slWikiEntryGuard'),
    rules: [
      {
        name: 'RateLimitPerIp',
        priority: 0,
        action,
        statement: { rateBasedStatement: { limit: config.rateLimit, aggregateKeyType: 'IP' } },
        visibilityConfig: visibility('slWikiEntryGuardRate'),
      },
      {
        name: 'OutsideAllowedReach',
        priority: 1,
        action,
        statement: { notStatement: { statement: allowed } },
        visibilityConfig: visibility('slWikiEntryGuardReach'),
      },
    ],
  });

  // AWS WAF delivers only to log groups named `aws-waf-logs-*`.
  const logGroupName = `aws-waf-logs-${stack.stackName}`;
  const logGroup = new cdk.aws_logs.LogGroup(stack, 'FrontDoorWebAclLogs', {
    logGroupName,
    retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const logging = new cdk.aws_wafv2.CfnLoggingConfiguration(stack, 'FrontDoorWebAclLogging', {
    resourceArn: webAcl.attrArn,
    // WAF takes the log group ARN without the `:*` suffix `logGroupArn` carries.
    logDestinationConfigs: [
      stack.formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: logGroupName,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      }),
    ],
    // Credentials stay out: the bearer token, the session cookie, and the query
    // string, which carries the one-time authorization code on sign-in callbacks.
    redactedFields: [
      ...['authorization', 'cookie'].map((Name) => ({ singleHeader: { Name } })),
      { queryString: {} },
    ],
    // Only what a rule refused or counted: that is what the trial period reads,
    // and logging every allowed request would cost a record per request.
    loggingFilter: {
      DefaultBehavior: 'DROP',
      Filters: [
        {
          Behavior: 'KEEP',
          Requirement: 'MEETS_ANY',
          Conditions: [{ ActionCondition: { Action: 'BLOCK' } }, { ActionCondition: { Action: 'COUNT' } }],
        },
      ],
    },
  });
  logging.node.addDependency(logGroup);

  return { webAclArn: webAcl.attrArn };
}

/**
 * Makes the API Gateway stage answer only requests that came through
 * `distribution`: an origin-verify secret on the distribution's API origin
 * always, and, in `block` mode, the stage's resource policy that refuses
 * anything else.
 *
 * The secret is generated by Secrets Manager at deploy time and read through
 * `{{resolve:secretsmanager:…}}` dynamic references, so its value is in no
 * template and no file. It stays readable to whoever may read the
 * distribution's config, the API's policy or the secret.
 */
export function lockApiToFrontDoor(
  stack: cdk.Stack,
  distribution: cdk.aws_cloudfront.Distribution,
  config: EntryGuardConfig,
): void {
  const restApis = stack.node
    .findAll()
    .filter((node): node is cdk.aws_apigateway.RestApi => node instanceof cdk.aws_apigateway.RestApi);
  if (restApis.length !== 1) {
    throw new Error(`Expected exactly one REST API behind the front door, found ${restApis.length}.`);
  }
  const restApi = restApis[0]!;

  // A REST API's resource policy takes effect only when the stage is deployed
  // again, so whatever changes the policy must also change the deployment.
  // `addToResourcePolicy` does not feed the deployment's hash in this CDK
  // version, so this is the only thing that redeploys the stage; without a
  // deployment to bump, a switch to `block` would synthesize and deploy fine
  // and leave the stage open.
  if (restApi.latestDeployment === undefined) {
    throw new Error(
      'The REST API has no managed deployment, so a resource policy change would never reach ' +
        'the stage. The entry guard cannot lock the API.',
    );
  }

  const secretValue = (generation: number): string => {
    const secret = new cdk.aws_secretsmanager.Secret(
      stack,
      generation === 0 ? 'EntryGuardOriginVerify' : `EntryGuardOriginVerifyG${generation}`,
      {
        description: 'The Referer value CloudFront sends to the API origin (sl-wiki entry guard).',
        generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
        // A retired generation has nothing worth keeping.
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    return secret.secretValue.unsafeUnwrap();
  };
  const { generation, acceptPrevious } = config.originSecret;
  const current = secretValue(generation);
  const accepted = acceptPrevious ? [current, secretValue(generation - 1)] : [current];

  addApiOriginHeader(distribution, restApi, current);

  if (config.mode === 'block') {
    const anyone = new cdk.aws_iam.AnyPrincipal();
    restApi.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [anyone],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
      }),
    );
    restApi.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.DENY,
        principals: [anyone],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
        conditions: {
          StringNotEquals: { 'aws:Referer': accepted.length === 1 ? accepted[0] : accepted },
        },
      }),
    );
  }
  // Bumped here, after the policy is settled (see the check above).
  restApi.latestDeployment.addToLogicalId({
    entryGuard: { mode: config.mode, generation, acceptPrevious },
  });
}

/**
 * Adds `Referer: <value>` to the origin custom headers of the distribution's
 * one origin that points at `restApi`. CloudFront replaces a viewer's own
 * `Referer` with it.
 */
function addApiOriginHeader(
  distribution: cdk.aws_cloudfront.Distribution,
  restApi: cdk.aws_apigateway.RestApi,
  value: string,
): void {
  const cfn = distribution.node.defaultChild as cdk.aws_cloudfront.CfnDistribution;
  const stack = cdk.Stack.of(cfn);
  const restApiRef = JSON.stringify(stack.resolve(restApi.restApiId));
  const resolved = stack.resolve(cfn.distributionConfig) as {
    origins?: Array<{
      domainName?: unknown;
      originCustomHeaders?: unknown[];
    }>;
  };
  const origins = resolved.origins ?? [];
  const matches = origins
    .map((origin, index) => ({ origin, index }))
    .filter(({ origin }) => {
      const domain = JSON.stringify(origin.domainName);
      return domain.includes('.execute-api.') && domain.includes(restApiRef);
    });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one CloudFront origin pointing at the REST API, found ${matches.length}. ` +
        'The entry guard cannot add its origin-verify header.',
    );
  }
  const { origin, index } = matches[0]!;
  // The override replaces the whole list, so any header the block sets on this
  // origin (today none) would be dropped silently — and one it adds later, or
  // lazily, would be lost too. Refuse rather than copy a snapshot of them.
  if ((origin.originCustomHeaders ?? []).length > 0) {
    throw new Error(
      'The API origin already sends custom headers; the entry guard would replace them. ' +
        'Merge them into the override before enabling the guard.',
    );
  }
  cfn.addPropertyOverride(`DistributionConfig.Origins.${index}.OriginCustomHeaders`, [
    { HeaderName: 'Referer', HeaderValue: value },
  ]);
}

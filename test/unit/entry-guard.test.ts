/**
 * The entry guard's CDK pieces, synthesized on a small stand-in for the
 * application stack: a REST API, and a distribution whose API origin is built
 * the way `@aws-cdk-blocks/core` builds it (host and stage sliced out of the
 * gateway URL with `Fn::Split`), next to an S3 origin.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { parseEntryGuardConfig, type EntryGuardConfig } from '../../cdk-blocks/entry-guard-config.js';
import { createFrontDoorWebAcl, lockApiToFrontDoor } from '../../cdk-blocks/entry-guard.js';

// Region only: a twelve-digit account id would trip the commit hook's patterns.
const env = { region: 'ap-northeast-1' };

function standIn(config: EntryGuardConfig): { stack: cdk.Stack; template: Template } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'App', { env });
  const api = new cdk.aws_apigateway.RestApi(stack, 'API', { cloudWatchRole: false });
  api.root.addMethod('ANY', new cdk.aws_apigateway.MockIntegration());

  // As `httpOriginFromEndpoint` in @aws-cdk-blocks/core does it.
  const gatewayUrl = `${api.url}cdk-blocks/api`;
  const baseUrl = cdk.Fn.select(0, cdk.Fn.split('/cdk-blocks/api', gatewayUrl));
  const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', baseUrl));
  const apiOrigin = new cdk.aws_cloudfront_origins.HttpOrigin(cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme)), {
    originPath: `/${cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme))}`,
  });

  const bucket = new cdk.aws_s3.Bucket(stack, 'Site');
  const distribution = new cdk.aws_cloudfront.Distribution(stack, 'Distribution', {
    defaultBehavior: { origin: cdk.aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(bucket) },
    additionalBehaviors: { '/cdk-blocks/api/*': { origin: apiOrigin } },
  });

  lockApiToFrontDoor(stack, distribution, config);
  return { stack, template: Template.fromStack(stack) };
}

function apiOriginHeaders(template: Template): unknown {
  const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  const origins = (distribution as { Properties: { DistributionConfig: { Origins: Array<Record<string, unknown>> } } })
    .Properties.DistributionConfig.Origins;
  const api = origins.filter((origin) => JSON.stringify(origin.DomainName).includes('.execute-api.'));
  assert.strictEqual(api.length, 1);
  const s3 = origins.filter((origin) => !JSON.stringify(origin.DomainName).includes('.execute-api.'));
  for (const origin of s3) assert.strictEqual(origin.OriginCustomHeaders, undefined);
  return api[0]!.OriginCustomHeaders;
}

const secretReference = Match.objectLike({
  'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('^\\{\\{resolve:secretsmanager:')])]),
});

test('count mode: the API origin sends the secret, and the stage stays open', () => {
  const { template } = standIn(parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP'] }));

  assert.deepStrictEqual(
    Match.exact([{ HeaderName: 'Referer', HeaderValue: secretReference }]).test(apiOriginHeaders(template))
      .failCount,
    0,
  );
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.hasResourceProperties('AWS::ApiGateway::RestApi', { Policy: Match.absent() });
});

test('block mode: the stage refuses any Referer but the secret', () => {
  const { template } = standIn(parseEntryGuardConfig({ mode: 'block', allowCountries: ['JP'] }));

  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Policy: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Allow', Action: 'execute-api:Invoke', Principal: { AWS: '*' } }),
        Match.objectLike({
          Effect: 'Deny',
          Action: 'execute-api:Invoke',
          Principal: { AWS: '*' },
          Condition: { StringNotEquals: { 'aws:Referer': secretReference } },
        }),
      ]),
    },
  });
  // The secret never appears as a literal: only the dynamic reference does.
  assert.ok(!JSON.stringify(template.toJSON()).match(/"aws:Referer":"[A-Za-z0-9]{64}"/));
});

test('a rotation with acceptPrevious accepts both generations and sends the new one', () => {
  const { template } = standIn(
    parseEntryGuardConfig({ mode: 'block', allowCountries: ['JP'], originSecret: { generation: 1, acceptPrevious: true } }),
  );
  template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  const secrets = Object.keys(template.findResources('AWS::SecretsManager::Secret'));
  assert.ok(secrets.some((id) => id.startsWith('EntryGuardOriginVerifyG1')));
  assert.ok(secrets.some((id) => id.startsWith('EntryGuardOriginVerify') && !id.startsWith('EntryGuardOriginVerifyG')));
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Policy: {
      Statement: Match.arrayWith([
        Match.objectLike({ Condition: { StringNotEquals: { 'aws:Referer': [secretReference, secretReference] } } }),
      ]),
    },
  });
  const headers = JSON.stringify(apiOriginHeaders(template));
  const g1 = secrets.find((id) => id.startsWith('EntryGuardOriginVerifyG1'))!;
  assert.ok(headers.includes(g1), 'the origin sends the new generation');
});

test('switching count to block deploys the stage again', () => {
  const deploymentIds = (config: EntryGuardConfig) =>
    Object.keys(standIn(config).template.findResources('AWS::ApiGateway::Deployment'));
  const count = deploymentIds(parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP'] }));
  const block = deploymentIds(parseEntryGuardConfig({ mode: 'block', allowCountries: ['JP'] }));
  assert.strictEqual(count.length, 1);
  assert.strictEqual(block.length, 1);
  assert.notStrictEqual(count[0], block[0]);
});

function webAclTemplate(config: EntryGuardConfig): Template {
  const stack = new cdk.Stack(new cdk.App(), 'Guard', { env: { ...env, region: 'us-east-1' } });
  createFrontDoorWebAcl(stack, config);
  return Template.fromStack(stack);
}

test('the web ACL refuses outside the countries, except claude.ai on the MCP paths', () => {
  const template = webAclTemplate(
    parseEntryGuardConfig({ mode: 'block', allowCountries: ['JP'], claudeAi: { enabled: true } }),
  );
  template.hasResourceProperties('AWS::WAFv2::IPSet', {
    Scope: 'CLOUDFRONT',
    Addresses: ['160.79.104.0/21', '153.61.208.0/20'],
  });
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'CLOUDFRONT',
    DefaultAction: { Allow: {} },
    VisibilityConfig: Match.objectLike({ SampledRequestsEnabled: false }),
    Rules: [
      Match.objectLike({
        Name: 'RateLimitPerIp',
        Action: { Block: {} },
        Statement: { RateBasedStatement: { Limit: 1000, AggregateKeyType: 'IP' } },
      }),
      Match.objectLike({
        Name: 'OutsideAllowedReach',
        Action: { Block: {} },
        Statement: {
          NotStatement: {
            Statement: {
              OrStatement: {
                Statements: [
                  { GeoMatchStatement: { CountryCodes: ['JP'] } },
                  {
                    AndStatement: {
                      Statements: [
                        Match.objectLike({ IPSetReferenceStatement: Match.anyValue() }),
                        {
                          OrStatement: {
                            Statements: [
                              '/mcp',
                              '/.well-known/oauth-protected-resource',
                              '/.well-known/oauth-protected-resource/mcp',
                              '/.well-known/oauth-authorization-server',
                            ].map((path) =>
                              Match.objectLike({
                                ByteMatchStatement: Match.objectLike({
                                  FieldToMatch: { UriPath: {} },
                                  PositionalConstraint: 'EXACTLY',
                                  SearchString: path,
                                }),
                              }),
                            ),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    ],
  });
  template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
    RedactedFields: [
      { SingleHeader: { Name: 'authorization' } },
      { SingleHeader: { Name: 'cookie' } },
      { QueryString: {} },
    ],
  });
  template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: Match.stringLikeRegexp('^aws-waf-logs-') });
});

test('count mode counts instead of refusing, and claude.ai off has no IP set', () => {
  const template = webAclTemplate(parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP'] }));
  template.resourceCountIs('AWS::WAFv2::IPSet', 0);
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Rules: [
      Match.objectLike({ Name: 'RateLimitPerIp', Action: { Count: {} } }),
      Match.objectLike({
        Name: 'OutsideAllowedReach',
        Action: { Count: {} },
        Statement: { NotStatement: { Statement: { GeoMatchStatement: { CountryCodes: ['JP'] } } } },
      }),
    ],
  });
});

test('refuses to lock a REST API whose stage it could not redeploy', () => {
  const stack = new cdk.Stack(new cdk.App(), 'NoDeploy', { env });
  const api = new cdk.aws_apigateway.RestApi(stack, 'API', { cloudWatchRole: false, deploy: false });
  api.root.addMethod('ANY', new cdk.aws_apigateway.MockIntegration());
  const bucket = new cdk.aws_s3.Bucket(stack, 'Site');
  const distribution = new cdk.aws_cloudfront.Distribution(stack, 'Distribution', {
    defaultBehavior: { origin: cdk.aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(bucket) },
  });
  assert.throws(
    () => lockApiToFrontDoor(stack, distribution, parseEntryGuardConfig({ mode: 'block', allowCountries: ['JP'] })),
    /no managed deployment/,
  );
});

test('refuses to replace custom headers the API origin already sends', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Headers', { env });
  const api = new cdk.aws_apigateway.RestApi(stack, 'API', { cloudWatchRole: false });
  api.root.addMethod('ANY', new cdk.aws_apigateway.MockIntegration());
  const host = cdk.Fn.select(2, cdk.Fn.split('/', api.url));
  const bucket = new cdk.aws_s3.Bucket(stack, 'Site');
  const distribution = new cdk.aws_cloudfront.Distribution(stack, 'Distribution', {
    defaultBehavior: { origin: cdk.aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(bucket) },
    additionalBehaviors: {
      '/api/*': { origin: new cdk.aws_cloudfront_origins.HttpOrigin(host, { customHeaders: { 'x-marker': 'v' } }) },
    },
  });
  assert.throws(
    () => lockApiToFrontDoor(stack, distribution, parseEntryGuardConfig({ mode: 'count', allowCountries: ['JP'] })),
    /already sends custom headers/,
  );
});

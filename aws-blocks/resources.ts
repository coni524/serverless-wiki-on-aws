/**
 * Building Block instances shared by the API layer.
 *
 * Kept separate from `index.ts` so that `access.ts` can use the table and the
 * auth block without importing the API namespace back (which would be a cycle).
 *
 * API reference for the installed versions:
 *   node_modules/@aws-blocks/bb-auth-cognito/README.md
 *   node_modules/@aws-blocks/bb-distributed-table/README.md
 */
import {
  Scope,
  AuthCognito,
  DistributedTable,
  FileBucket,
  KnowledgeBase,
} from '@aws-blocks/blocks';

import { itemSchema } from './model.js';

// The scope name must not begin with "aws" (case-insensitive): it prefixes the
// physical names of deployed resources, and several services reserve that
// prefix — SSM rejects parameter names starting with "aws", and the first
// deploy failed on exactly that (the project was then named aws-wiki).
export const scope = new Scope('sl-wiki');

// ─── Auth ────────────────────────────────────────────────────────────────────
// Cognito groups are deliberately not configured: authorization lives in
// DynamoDB, not in the user pool. `requireRole` must not be used.
//
// `selfSignUp: false` closes public registration. A deployed pool rejects the
// SignUp API outright; accounts are created by an administrator, and will come
// from the corporate IdP once OIDC/SAML federation lands.
//
// Note the mock's behaviour differs: locally this flag only removes the
// "Create Account" action from the sign-in UI, and a direct `signUp` call still
// succeeds. That is what lets the e2e suite provision its own throwaway user.
//
// `signInWith: 'email'` makes the email address the Cognito username. Changing
// this on a deployed pool is destructive, so it is fixed before the first deploy.
//
// `mfa: 'required'` with TOTP as the only factor. A global administrator can
// read and write every space, so a single stolen password must not be enough;
// requiring the second factor for everyone is what makes that true, since the
// pool has no way to require it of one account and not another.
//
// TOTP alone, not email codes: the sign-in name *is* the email address here, so
// an email factor would put both factors in the same mailbox. It also needs an
// SES sender the pool does not have. SMS is absent for the same reason plus the
// per-message cost. A user enrols on their first sign-in — the pool issues the
// setup challenge itself, which the auth block's `<Authenticator>` renders.
//
// Note this does not apply to sessions that already exist: they carry a refresh
// token, and a refresh is not a sign-in. Turning this on means dropping the
// records in the session table (`docs/runbooks/enable-mfa.md`).
export const auth = new AuthCognito(scope, 'auth', {
  signInWith: 'email',
  selfSignUp: false,
  mfa: 'required',
  mfaTypes: ['TOTP'],
  passwordPolicy: {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: true,
  },
  sessionTtlSeconds: 60 * 60 * 24 * 30, // 30 days — shorter than the 400-day default
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});

// ─── Permission table ────────────────────────────────────────────────────────
// One table, single-table design, one reverse index. Do not add a
// `scan()` call against it: every access pattern this project has is reachable
// from the primary key or `gsi1`.
//
// Generics are all left to inference on purpose — passing one explicit type
// argument breaks key-type inference (see the block's README).
export const table = new DistributedTable(scope, 'permissions', {
  schema: itemSchema,
  key: { partitionKey: 'pk', sortKey: 'sk' },
  indexes: {
    gsi1: { partitionKey: 'gsi1pk', sortKey: 'gsi1sk' },
  },
});

// ─── Content bucket ──────────────────────────────────────────────────────────
// One bucket for page bodies and attachments alike. Splitting them
// would only be justified by differing versioning, and neither uses it: the
// body history is kept as ordinary objects under distinct revision keys, so a
// deleted space is reclaimed by one `spaces/<spaceId>/` prefix sweep that picks
// up bodies and attachments together.
//
// Versioning stays off deliberately. It is not a saving of effort — with it,
// the body write and the metadata write carry separate orderings, and the
// last-writer-wins rule chosen for page saves stops holding.
//
// `blockPublicAccess` is left at its default and must not be changed: every
// read and write goes through a presigned URL or the API.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

export const content = new FileBucket(scope, 'content', {
  removalPolicy: process.env.BLOCKS_SANDBOX === 'true' ? 'destroy' : 'retain',
  // Browsers upload and download attachments straight to S3, so the bucket
  // needs the origins named explicitly — never a wildcard. Unset means no
  // cross-origin access, which is correct for a same-origin deployment and for
  // local development, where the mock ignores CORS anyway.
  ...(corsOrigins.length > 0
    ? {
        corsRules: [
          {
            allowedOrigins: corsOrigins,
            allowedMethods: ['GET', 'PUT', 'HEAD'] as const,
            allowedHeaders: ['*'],
            maxAge: 3600,
          },
        ],
      }
    : {}),
});

// ─── Search corpus ────────────────────────────────────────────────────────────
// Semantic search over page text, via the KnowledgeBase block (Bedrock Knowledge
// Bases + S3 Vectors + Titan Text Embeddings V2). The block indexes a *corpus* of
// normalized page markdown that `search-corpus.ts` maintains on every save — the
// block itself has no runtime write API, so the corpus lives on its outside.
//
// The block reads its source differently per environment, so the corpus is
// written to whichever it will read (see `search-corpus.ts`):
//   - AWS: an s3:// bucket, imported here by name. `index.cdk.ts` creates that
//     bucket (its name must be fixed at synth, which a block-generated bucket name
//     is not) and passes it in through `SEARCH_CORPUS_BUCKET` before this module
//     is imported during synth.
//   - Local dev: a folder on disk. `s3://` sources are not supported by the mock.
//
// The folder name here is the app's own; nothing reads into a block's mock
// storage. It must match the path `search-corpus.ts` writes to.
export const SEARCH_CORPUS_LOCAL_DIR = '.search-corpus';

const corpusBucket = process.env.SEARCH_CORPUS_BUCKET;

export const search = new KnowledgeBase(scope, 'search', {
  source:
    corpusBucket !== undefined && corpusBucket !== ''
      ? `s3://${corpusBucket}/`
      : SEARCH_CORPUS_LOCAL_DIR,
  description: 'Wiki page text for semantic search',
  // The S3 Vectors store the block provisions follows the same teardown rule as
  // the content bucket: dropped in a sandbox, retained otherwise so a real
  // deployment never silently loses its index (see the block's D-KB-10/-11).
  removalPolicy: process.env.BLOCKS_SANDBOX === 'true' ? 'destroy' : 'retain',
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// There is none in the application. The first global administrator is four
// records the operator writes straight into the table with
// `aws-blocks/scripts/seed-admin.ts`, so no API can raise anyone's own
// permissions.

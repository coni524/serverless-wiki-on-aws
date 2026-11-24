/**
 * Building Block instances shared by the API layer.
 *
 * Kept separate from `index.ts` so that `access.ts` can use the table and the
 * auth block without importing the API namespace back (which would be a cycle).
 *
 * API reference for the installed versions:
 *   node_modules/@aws-cdk-blocks/bb-auth/README.md
 *   node_modules/@aws-cdk-blocks/bb-kv-store/README.md
 */
import { Scope, Auth, KVStore, FileBucket, getDeploymentType } from 'aws-cdk-blocks';

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
// `selfSignUp` is off, unconditionally, which closes public registration: the
// pool rejects the SignUp API outright, and accounts are created by an
// administrator or arrive through a corporate IdP. It is not switched by
// environment, not even for the local dev server: a setting that differs by
// environment is one condition away from opening a deployed pool. The local
// pool refuses sign-up as Cognito does, so local accounts, the e2e suite's
// included, are created beforehand with `scripts/local-users.ts`.
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
// token, and a refresh is not a sign-in, so Cognito never puts a factor in
// front of one. Turning this on over a pool that is already in use therefore
// takes one more step from the operator — delete every record in the auth
// block's session store table, which sends each user back through a real
// sign-in.
// `users.attributes` adds `custom:groups` to the pool. The identity provider
// registration in `index.cdk.ts` copies a federated sign-in's group claim into
// it, and the sign-in hook in `federation.ts` reads it back out of the ID
// token — no password account ever carries a value. String and mutable (the
// defaults; Cognito's default length cap of 2048 applies), and declared
// unconditionally because a custom attribute, once on a pool, can never be
// removed — making it conditional would only make deploys diverge.
//
// `userWritable: false` keeps it out of the write attributes of the block's app
// client and makes the block refuse an end-user write of it, so the value can
// only come from the identity provider registration. It is what role groups are
// derived from, so a user able to set it would be able to pick their own
// permissions at the next federated sign-in.
export const auth = new Auth(scope, 'auth', {
  users: {
    signInWith: ['email'],
    attributes: [{ name: 'groups', userWritable: false }],
  },
  emailPassword: {
    selfSignUp: false,
    passwordPolicy: {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireDigits: true,
      requireSymbols: true,
    },
  },
  mfa: { mode: 'required', types: ['TOTP'] },
  session: {
    ttlSeconds: 60 * 60 * 24 * 30, // 30 days
    crossDomain: getDeploymentType() === 'sandbox',
  },
  // The pool holds every account, and the permission records point at its
  // `sub`s, so a deployed stack keeps it when the stack is deleted or the
  // block is replaced. Stated explicitly rather than left to the stack preset,
  // so the intent does not depend on which preset the stack was created with.
  removalPolicy: getDeploymentType() === 'sandbox' ? 'destroy' : 'retain',
});

// ─── Permission table ────────────────────────────────────────────────────────
// One table, single-table design, one reverse index. Do not add a
// `scan()` call against it: every access pattern this project has is reachable
// from the primary key or `gsi1`.
//
// A `schema` with a declared `key` is the store's record form: the key fields
// are the table's key schema, so the table, its key and its items are the ones
// the store has always had. Generics are left to inference — the schema sets
// the value type, and a type argument beside it is not allowed.
export const table = new KVStore(scope, 'permissions', {
  schema: itemSchema,
  key: { partitionKey: 'pk', sortKey: 'sk' },
  indexes: {
    gsi1: { partitionKey: 'gsi1pk', sortKey: 'gsi1sk' },
  },
});

/** The primary key of a stored item: the two fields the table is keyed on. */
export function keyOf(item: { pk: string; sk: string }): { pk: string; sk: string } {
  return { pk: item.pk, sk: item.sk };
}

/**
 * Write one item under its own key.
 *
 * The store takes the key and the value apart (`put(key, value)`), and refuses
 * a value whose key fields disagree with the key. Every item here carries its
 * key in its own `pk` / `sk`, so the key is always read off the value and the
 * two cannot disagree.
 */
export function putItem(
  item: Parameters<typeof table.put>[1] & { pk: string; sk: string },
  options?: Parameters<typeof table.put>[2],
): Promise<void> {
  return table.put(keyOf(item), item, options);
}

/**
 * The values of a query, in the order it returns them.
 *
 * A query yields `{ key, value }` entries and reads every page of its
 * partition unless given a `limit`; the callers here only ever want the stored
 * items, so this unwraps them.
 */
export async function valuesOf<T>(results: AsyncIterable<{ value: T }>): Promise<T[]> {
  const values: T[] = [];
  for await (const { value } of results) values.push(value);
  return values;
}

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
  removalPolicy: getDeploymentType() === 'sandbox' ? 'destroy' : 'retain',
  // The block turns versioning on unless told otherwise; see above for why it
  // stays off here.
  versioned: false,
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

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// There is none in the application. The first global administrator is four
// records the operator writes straight into the table with
// `cdk-blocks/scripts/seed-admin.ts`, so no API can raise anyone's own
// permissions.

/**
 * The external sync API — `POST /ext/<method>` on the existing backend Lambda.
 *
 * This is the surface a sync client speaks to: a program running outside a
 * browser, holding the user's own OAuth token, mirroring a space into local
 * files. The Obsidian plugin is the first one.
 *
 * ─── Why it is not the MCP server, and not the UI API ───────────────────────
 * The UI-facing `ApiNamespace` has every operation a sync client needs, but its
 * authentication is the AuthCognito session cookie, which is issued in a browser
 * and reaches nothing outside one. The MCP server has bearer authentication, but
 * its tools are deliberately narrowed for an AI caller: no move, no attachments,
 * and deletion limited to leaf pages. So the gap was never the operations, only
 * the pairing of operations with an authentication method — and this module
 * closes it without widening what a model can reach.
 *
 * ─── What this layer is allowed to contain ──────────────────────────────────
 * Argument parsing and delegation. Nothing else. Every method below hands the
 * resolved `Access` to the same function the ApiNamespace method calls, so the
 * permission walk, the space gate, and the input bounds are reached by one code
 * path, not two. A rule enforced here and not there would be a rule the UI could
 * be used to sidestep — or the other way round.
 *
 * ─── The wire format ────────────────────────────────────────────────────────
 *   POST /ext/<method>   →  request body: a JSON object of named arguments
 *                           response:     the method's own JSON result
 *   400  the arguments do not parse           401  no or bad token
 *   403  scope missing, or the space refuses  404  no such page or method
 *
 * Plain JSON, no JSON-RPC envelope: the caller is a program that already knows
 * which method it wants, and an envelope would only add a layer to unwrap.
 */
import { RawRoute } from '@aws-blocks/blocks';
import { ApiError, type BlocksContext } from '@aws-blocks/core';
import { z } from 'zod';

import { scope } from './resources.js';
import {
  OAUTH_CONFIGURED,
  SCOPE_WRITE,
  type Caller,
  Refusal,
  authenticate,
  baseUrl,
  guardOrigin,
  insufficientScope,
  protectedResourceDocument,
  sendRefusal,
} from './bearer-auth.js';
import { type Access } from './access.js';
import {
  createAttachmentDownloadUrls,
  createAttachmentUploadUrl,
  deleteAttachment,
  listAttachments,
} from './attachment-ops.js';
import {
  createFolder,
  createPage,
  deleteFolder,
  deletePage,
  listPages,
  movePage,
  mySpaces,
  readPageDetail,
  renameFolder,
  updatePage,
} from './wiki-ops.js';
import { EXT_METHOD_MODES, type ExtMethodName } from './ext-methods.js';

/** The path prefix every method below hangs off. */
const PREFIX = '/ext';

/**
 * The RFC 9728 document that describes `/ext`, as a URL to put in a refusal.
 *
 * Built from the request's own path, which is `/ext/<method>` — so the suffix
 * stripped to recover the deployment's base URL is the whole of it, method
 * included.
 */
const metadataUrl = (context: BlocksContext, method: string) =>
  `${baseUrl(context, `${PREFIX}/${method}`)}/.well-known/oauth-protected-resource/ext`;

// ─── Methods ─────────────────────────────────────────────────────────────────
// The eleven sync methods, plus the three folder writes. Read methods
// need `slwiki/read`, which `authenticate`
// has already required of every token that gets this far; write methods need
// `slwiki/write` on top, checked before the call is made.

/** One method as its route parses it and runs it. */
type MethodSpec = {
  name: ExtMethodName;
  parameters: z.ZodType;
  /** Requires `slwiki/write` on the access token, on top of the space check. */
  write: boolean;
  run: (access: Access, input: never) => Promise<unknown>;
};

/**
 * Author a method with its input type inferred; the registry erases it again.
 *
 * The read/write mode is looked up rather than passed. Naming it at each method
 * would put the one mistake that local tests cannot catch — a write marked as a
 * read — in the place most likely to be copied from the method above it. See
 * `ext-methods.ts`.
 */
function method<S extends z.ZodType>(spec: {
  name: ExtMethodName;
  parameters: S;
  run: (access: Access, input: z.infer<S>) => Promise<unknown>;
}): MethodSpec {
  return {
    name: spec.name,
    parameters: spec.parameters,
    write: EXT_METHOD_MODES[spec.name] === 'write',
    run: spec.run as MethodSpec['run'],
  };
}

/**
 * An optional mark the client either holds or does not — a cursor, a stamp.
 *
 * A client with none of it may say so as `null`, as `''`, or by leaving the
 * field out; none of the three is a value, and the functions below expect the
 * absence to be spelled `undefined` (see `given` in `index.ts` for why reading
 * one as a real cursor silently returns an empty first page).
 */
const optionalMark = z
  .string()
  .nullish()
  .transform((value) => (value === undefined || value === null || value === '' ? undefined : value));

/**
 * An optional page id, which is a different thing from an optional mark.
 *
 * `''` is refused rather than folded into "absent". A page id is a name, and the
 * empty string names nothing, so a client that sends one has a bug — most likely
 * an unset variable. Folding it into absence would hide that: on `createPage` it
 * would quietly make a top-level page, and on `movePage` it would quietly leave
 * the parent where it was. Both look like success to the client that sent it.
 *
 * `null` and "absent" both survive, because `movePage` reads them differently:
 * absent leaves the parent alone, `null` moves the page to the top level.
 */
const optionalPageId = z.string().min(1, 'A page id may not be empty').nullish();

const METHODS: MethodSpec[] = [
  // ─── Spaces ────────────────────────────────────────────────────────────────

  /**
   * The spaces this user may read, with the permission held on each.
   *
   * The permission matters to a sync client in a way it does not to a reader:
   * `read` means the local folder must be mirrored one way, and pushing a local
   * edit back would only earn a refusal. The plugin uses this to mark a space
   * as fetch-only rather than discovering it one failed write at a time.
   */
  method({
    name: 'listSpaces',
    parameters: z.object({}),
    run: async (access) => ({
      spaces: (await mySpaces(access)).map(({ spaceId, name, description, permission }) => ({
        spaceId,
        name,
        description,
        permission,
      })),
    }),
  }),

  // ─── Pages ─────────────────────────────────────────────────────────────────

  /**
   * Every page in a space, one keyset page of results at a time.
   *
   * The snapshot a sync cycle starts from: parent, title, revision and
   * `updatedAt` for the whole tree, which is what lets the client decide what
   * changed without reading a single body.
   */
  method({
    name: 'listPages',
    parameters: z.object({ spaceId: z.string().min(1), cursor: optionalMark }),
    run: async (access, input) => await listPages(access, input.spaceId, input.cursor),
  }),

  /**
   * A page with its body and its breadcrumb.
   *
   * `knownStamp` is the freshness mark the client already holds — the revision
   * and update time as one string. Passing it back means the body is
   * only sent when it has actually changed, so a sync cycle over an unchanged
   * space transfers metadata and nothing else.
   */
  method({
    name: 'getPage',
    parameters: z.object({ pageId: z.string().min(1), knownStamp: optionalMark }),
    run: async (access, input) => await readPageDetail(access, input.pageId, input.knownStamp),
  }),

  method({
    name: 'createPage',
    parameters: z.object({
      spaceId: z.string().min(1),
      title: z.string(),
      body: z.string().optional(),
      parentPageId: optionalPageId,
    }),
    run: async (access, input) =>
      await createPage(access, {
        spaceId: input.spaceId,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.parentPageId === undefined ? {} : { parentPageId: input.parentPageId }),
      }),
  }),

  method({
    name: 'updatePage',
    parameters: z.object({
      pageId: z.string().min(1),
      title: z.string().optional(),
      body: z.string().optional(),
    }),
    run: async (access, input) =>
      await updatePage(access, input.pageId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
  }),

  /**
   * Reparent a page, reorder it among its siblings, or both.
   *
   * `null` and "absent" mean different things here and the schema keeps them
   * apart: an absent `parentPageId` leaves the parent alone, while an explicit
   * `null` moves the page to the top level. A client that flattened the two
   * would silently promote every page it meant to leave where it was.
   */
  method({
    name: 'movePage',
    parameters: z.object({
      pageId: z.string().min(1),
      parentPageId: optionalPageId,
      afterPageId: optionalPageId,
    }),
    run: async (access, input) =>
      await movePage(access, input.pageId, {
        ...('parentPageId' in input ? { parentPageId: input.parentPageId } : {}),
        ...('afterPageId' in input ? { afterPageId: input.afterPageId } : {}),
      }),
  }),

  /**
   * Delete a page, saying what should happen to its children.
   *
   * Unlike the MCP tool, which is fixed at `reject` because a model must not
   * cascade over pages nobody named, a sync client may pass any of
   * the three: it is relaying a decision its own user made about their own
   * files, and a mirrored folder deleted locally has no leaf-first order to
   * offer. The default stays `reject`.
   */
  method({
    name: 'deletePage',
    parameters: z.object({
      pageId: z.string().min(1),
      children: z.enum(['reject', 'cascade', 'reparent']).default('reject'),
    }),
    run: async (access, input) => await deletePage(access, input.pageId, input.children),
  }),

  // ─── Folders ───────────────────────────────────────────────────────────────
  // The three writes a folder has. There is no folder read: `listPages` already
  // returns both kinds with their `kind`, and that listing is the snapshot a
  // sync cycle works from.

  method({
    name: 'createFolder',
    parameters: z.object({
      spaceId: z.string().min(1),
      title: z.string(),
      parentPageId: optionalPageId,
    }),
    run: async (access, input) =>
      await createFolder(access, {
        spaceId: input.spaceId,
        title: input.title,
        ...(input.parentPageId === undefined ? {} : { parentPageId: input.parentPageId }),
      }),
  }),

  method({
    name: 'renameFolder',
    parameters: z.object({ folderId: z.string().min(1), title: z.string() }),
    run: async (access, input) => await renameFolder(access, input.folderId, input.title),
  }),

  /**
   * Delete a folder, saying what should happen to its contents.
   *
   * The default refuses, and the sync plugin takes it: removing a directory in
   * the vault removes everything under it, so the plugin has the whole subtree
   * to delete and sends it deepest first. A folder that is still not empty when
   * its own turn comes therefore holds something the Wiki has and that vault
   * never received, and refusing reports it. `cascade` remains for a caller
   * that has no such order to replay.
   */
  method({
    name: 'deleteFolder',
    parameters: z.object({
      folderId: z.string().min(1),
      children: z.enum(['reject', 'cascade', 'reparent']).default('reject'),
    }),
    run: async (access, input) => await deleteFolder(access, input.folderId, input.children),
  }),

  // ─── Attachments ───────────────────────────────────────────────────────────

  method({
    name: 'createAttachmentUploadUrl',
    parameters: z.object({
      pageId: z.string().min(1),
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
    }),
    run: async (access, input) => await createAttachmentUploadUrl(access, input),
  }),

  method({
    name: 'listAttachments',
    parameters: z.object({ pageId: z.string().min(1) }),
    run: async (access, input) => await listAttachments(access, input.pageId),
  }),

  method({
    name: 'createAttachmentDownloadUrls',
    parameters: z.object({ pageId: z.string().min(1), attachmentIds: z.array(z.string()) }),
    run: async (access, input) =>
      await createAttachmentDownloadUrls(access, input.pageId, input.attachmentIds),
  }),

  method({
    name: 'deleteAttachment',
    parameters: z.object({ pageId: z.string().min(1), attachmentId: z.string().min(1) }),
    run: async (access, input) => await deleteAttachment(access, input.pageId, input.attachmentId),
  }),
];

// ─── Request handling ────────────────────────────────────────────────────────

/**
 * Read the request body as a JSON object of named arguments.
 *
 * An empty body is an empty object, which is what `listSpaces` sends. Anything
 * that is not a JSON object — an array, a bare string, malformed text — is
 * refused here rather than handed to a schema that would report it as a missing
 * field.
 */
async function readArguments(context: BlocksContext): Promise<Record<string, unknown>> {
  const raw = (await context.request.text()).trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Refusal(400, {
      error: 'invalid_request',
      error_description: 'The request body is not valid JSON.',
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Refusal(400, {
      error: 'invalid_request',
      error_description: 'The request body must be a JSON object of named arguments.',
    });
  }
  return parsed as Record<string, unknown>;
}

/** Run one method, having authenticated. */
async function runMethod(
  context: BlocksContext,
  spec: MethodSpec,
  caller: Caller,
): Promise<unknown> {
  // The scope gate, before the arguments are even read. Not a substitute for the
  // space check inside the operation — it is the coarser of the two, and both
  // have to pass.
  //
  // It goes first so that a token lacking `slwiki/write` is told so even when
  // the call is also malformed. A 400 would send the client off to fix its
  // arguments and arrive at the same wall; the 403 names the missing scope,
  // which is something it can actually go and obtain.
  if (spec.write && !caller.scopes.has(SCOPE_WRITE)) {
    throw insufficientScope(metadataUrl(context, spec.name), SCOPE_WRITE);
  }

  const parsed = spec.parameters.safeParse(await readArguments(context));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where =
      first === undefined || first.path.length === 0 ? '' : ` at ${first.path.join('.')}`;
    throw new Refusal(400, {
      error: 'invalid_request',
      error_description: `Invalid arguments${where}: ${first?.message ?? 'invalid'}`,
    });
  }

  return await spec.run(caller.access, parsed.data as never);
}

/**
 * One route per method, rather than a single `/ext/{method}` with the name as a
 * path parameter.
 *
 * `RawRoute` supports the parameterized form, so both are available. This shape
 * is chosen because it puts the "no such method" answer in the router: a client
 * that misspells a method name gets a plain 404 before any handler runs, with
 * nothing to decide and no chance of a typo resolving to a neighbouring method.
 * The cost is a construct per method, which is fourteen of them.
 */
for (const spec of METHODS) {
  new RawRoute(scope, `ext-${spec.name}`, {
    method: 'POST',
    path: `${PREFIX}/${spec.name}`,
    handler: async (context) => {
      try {
        guardOrigin(context, 'sync');
        const caller = await authenticate(context, metadataUrl(context, spec.name));
        context.response.send(await runMethod(context, spec, caller));
      } catch (error: unknown) {
        if (sendRefusal(context, error)) return;
        // `ApiError` says something about the request — a refused space, a page
        // that is gone, a title too long — and the RawRoute wrapper relays it
        // with the right status. Anything else is a fault whose message was
        // written for whoever reads the logs, so it is logged and replaced.
        if (error instanceof ApiError) throw error;
        console.error(`Sync API handler error (${spec.name}):`, error);
        context.response.status = 500;
        context.response.send({ error: 'server_error', error_description: 'The request failed.' });
      }
    },
  });
}

/**
 * RFC 9728 — what protects `/ext` and which authorization server issues for it.
 *
 * The sync client is configured with this deployment's address rather than
 * discovering it, so nothing is expected to fetch this in the normal course.
 * It exists so the `resource_metadata` a refusal points at resolves to a real
 * document, which is what lets a client that *does* follow the header recover
 * by asking for the scope it lacks.
 */
new RawRoute(scope, 'ext-protected-resource', {
  method: 'GET',
  path: '/.well-known/oauth-protected-resource/ext',
  handler: async (context) => {
    if (!OAUTH_CONFIGURED) {
      context.response.status = 404;
      context.response.send({ error: 'not_found' });
      return;
    }
    context.response.send(
      protectedResourceDocument(
        baseUrl(context, '/.well-known/oauth-protected-resource/ext'),
        PREFIX,
      ),
    );
  },
});

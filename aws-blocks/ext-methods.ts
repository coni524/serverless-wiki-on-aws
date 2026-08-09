/**
 * Which `/ext/*` methods read and which write.
 *
 * Separate from `ext.ts`, and importing nothing, for one reason: this is the
 * table a test can check. `ext.ts` builds `RawRoute`s and Building Block
 * instances at import, so a test process cannot load it to see whether a method
 * was registered with the right mode — and the mode is exactly the thing whose
 * mistakes are invisible. A method wrongly marked `read` still passes every
 * local test, because local development grants both scopes; it fails only in
 * production, as a token with `slwiki/read` writing a page.
 *
 * So the mode is not written next to each method. It is written here once,
 * `ext.ts` looks it up, and a method missing from this table fails at import
 * rather than defaulting to the permissive answer.
 *
 * This is the token-level gate only. It says what a *token* may attempt; what
 * its *user* may do is the DynamoDB permission walk, which every method goes
 * through regardless of what this table says.
 */
export const EXT_METHOD_MODES = {
  listSpaces: 'read',
  listPages: 'read',
  getPage: 'read',
  createPage: 'write',
  updatePage: 'write',
  movePage: 'write',
  deletePage: 'write',
  createFolder: 'write',
  renameFolder: 'write',
  deleteFolder: 'write',
  createAttachmentUploadUrl: 'write',
  listAttachments: 'read',
  createAttachmentDownloadUrls: 'read',
  deleteAttachment: 'write',
} as const;

export type ExtMethodName = keyof typeof EXT_METHOD_MODES;

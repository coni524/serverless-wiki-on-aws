/**
 * Refusal wording that more than one surface has to share.
 *
 * This module imports nothing. That is the point: the surfaces that need these
 * strings live behind CDK constructs (`resources.ts`), and a test that wants to
 * check the wording cannot load those. Keeping the words here lets the wording
 * be asserted directly, without standing up a Lambda.
 *
 * Written in English, as every refusal the API produces is. The callers are a
 * screen that can be read in either language, an assistant answering in the
 * reader's, an MCP client, and a sync plugin — and the request carries no
 * language for any of them to be worded in. A refusal that has to reach the
 * reader in their own language is given a structured error name instead, and
 * the screen words it; `PAGE_HAS_CHILDREN` in `access.ts` is the one that is.
 */

/**
 * How a surface that can only delete leaf pages must word the refusal.
 *
 * `access.ts` raises `PageHasChildrenError` with a message written for the UI,
 * whose delete takes `cascade` and `reparent`. The AI assistant and
 * the MCP server expose neither, and neither can move a page to a
 * different parent either. A model handed the UI's wording therefore asks for
 * arguments its tool does not declare — and zod strips unknown keys instead of
 * rejecting them, so a retry parses down to the same call and earns the same
 * refusal. Whether the model retries is up to the model; what is certain is
 * that nothing stops it. No error surfaces, the page never moves, and the user
 * hears only that the delete failed.
 *
 * So both surfaces say this instead, and say it identically. Naming only what
 * they can actually do is the whole requirement; if a third leaf-only surface
 * appears, it calls this too rather than wording its own.
 */
export function leafOnlyDeleteRefusal(childCount: number): string {
  const held = childCount === 1 ? '1 child page' : `${childCount} child pages`;
  const them = childCount === 1 ? 'it' : 'them';
  return `This page has ${held} and cannot be deleted. Delete ${them} first, then try again.`;
}

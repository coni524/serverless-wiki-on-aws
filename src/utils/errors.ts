/**
 * Turn whatever the RPC client threw into a line of text for the UI.
 *
 * The last resort stays English and stays out of the dictionary. It stands in
 * for a message the API did not send, and every message the API does send is
 * English whichever language the screen is in (`aws-blocks/refusals.ts`) — so
 * a translated stand-in would be the one error text that changes language, and
 * the reader would have no way to tell it apart from one the server wrote.
 */
export function errMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'The request failed';
}

/**
 * The structured `name` an ApiError carries across the wire (preserved by the
 * RPC client), or undefined. Branch on this — never on the message text.
 */
export function errName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * Mirrors `PAGE_HAS_CHILDREN` in `aws-blocks/access.ts`. A delete of a page that
 * still has children is refused with this structured name so the UI can offer
 * the cascade / reparent choice without matching the English message text.
 */
export const PAGE_HAS_CHILDREN_ERROR = 'PageHasChildrenException';

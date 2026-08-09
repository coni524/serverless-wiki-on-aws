/**
 * Repairs applied to text a model composed, before it is stored or shown.
 *
 * This module imports nothing, for two reasons at once. The write path reaches
 * it from behind CDK constructs (`assistant.ts`, `mcp.ts`), and the approval card
 * reaches it from the browser (`src/components/PendingChange.tsx`) — and those
 * two must apply exactly the same rule. The card shows what the write would
 * store; a repair on one side only would put a readable diff in front of the
 * user and write something else, or the reverse. Keeping the rule in one
 * dependency-free file is what stops the two from drifting apart, the same
 * argument `refusals.ts` makes for shared wording.
 */

/**
 * Turn a body whose line breaks arrived as the two characters `\` and `n` back
 * into a body with line breaks.
 *
 * A model composing a whole Markdown page sometimes writes the escape rather
 * than the character, and the body reaches the tool as one very long line
 * reading `heading\n\nbody`. Nothing downstream can recover from that: the page is
 * stored as a single line, Markdown stops seeing headings and list items, and
 * the approval card shows the whole page as one added line — which is where this
 * was noticed.
 *
 * The rewrite only happens when the body holds no real line break anywhere. A
 * body that is genuinely multi-line proves its writer can send one, so the `\n`
 * sequences left in it are text the author meant — a code sample, an explanation
 * of the escape itself — and are left alone. What stays wrong is a deliberate
 * one-line page about `\n`; that is the price, and it is smaller than a whole
 * page arriving unreadable.
 *
 * Only model-composed text goes through this. The editor sends what the person
 * typed, and a person typing `\n` into a one-line page means those characters.
 */
export function unescapeModelNewlines(body: string): string {
  if (body.includes('\n') || body.includes('\r')) return body;
  if (!body.includes('\\n')) return body;
  return body.replace(/\\r\\n|\\n/g, '\n');
}

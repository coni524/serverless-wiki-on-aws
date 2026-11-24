/**
 * The screen the user has open, as the AI assistant is told about it.
 *
 * The assistant sits beside the page the user is reading, so "reword this page"
 * is the ordinary way to ask for an edit — and the model has no way to know what
 * "this" points at unless the request says so. Nothing else tells it:
 * the tools take ids, and the conversation history holds only what was typed.
 * Without this, a request about the open page sent the assistant searching for a
 * page the user was already looking at.
 *
 * The screen is prepended to the user's message rather than added to the system
 * prompt, because the Agent block settles the system prompt once, at
 * construction, while the open page changes between turns. Being part of the
 * message also keeps each turn's history honest about what was on screen when it
 * was asked.
 *
 * Like `refusals.ts`, this module imports nothing: `assistant.ts` and `index.ts`
 * both live behind CDK constructs, and the wording is worth asserting without
 * standing up a Lambda to do it.
 */

/** The screen after the client's claim has been resolved and the space gated. */
export type Viewing = {
  spaceId: string;
  spaceName: string;
  /** Absent when the user is on the space itself rather than on a page. */
  page?: { pageId: string; title: string };
};

/**
 * The language the screen is being read in, as the block reports it.
 *
 * It rides here rather than in the system prompt for the same reason the open
 * page does: the Agent block settles the prompt once, at construction, and a
 * reader can switch language between two turns of one conversation. The prompt
 * names this line and tells the model to answer in what it says.
 *
 * It is a closed set, and `index.ts` checks a caller's claim against it before
 * it gets here. What the client sends ends up inside the model's input, so the
 * one thing that must not happen is a string being passed through.
 */
export type ViewingLocale = 'ja' | 'en';

export function isViewingLocale(value: unknown): value is ViewingLocale {
  return value === 'ja' || value === 'en';
}

/**
 * The two lines that bracket the screen block.
 *
 * They are what `withoutViewing` recognises, and they are named in the system
 * prompt so the model knows the lines between them come from the Wiki. A user is
 * free to type the same two lines and gains nothing by doing so: the block names
 * a page and nothing more, and every tool still resolves the acting user's own
 * permissions before it touches anything.
 */
const HEADER = '[screen context]';
const END = '[end of screen context. what follows is the user input]';

/** Named for the system prompt, which has to quote both markers exactly. */
export const VIEWING_MARKERS = { header: HEADER, end: END };

/**
 * A stored name as one line of the block, whatever it holds.
 *
 * The two markers are lines, so a name carrying a line break could write the
 * end marker itself and have everything after it read as the user's own
 * instruction — a title anyone with `write` on a space the reader can see is
 * free to compose. `cleanTitle` and `cleanName` refuse those characters now,
 * but names stored before they did are still in the table, and this block is
 * where one would be believed. Folded to a space rather than dropped, so the
 * words on either side do not run together.
 */
const oneLine = (value: string): string => value.replace(/[\p{Cc}\u2028\u2029]/gu, ' ');

/**
 * The message as the agent receives it: the open screen, then what was typed.
 *
 * Nothing is added when neither a screen nor a language resolved, so a message
 * sent from a screen with no space open and no language claimed reaches the
 * agent exactly as it did before. The two are independent: a reader on the
 * space list has no page to name but still has a language to be answered in.
 */
export function withViewing(
  text: string,
  viewing: Viewing | null,
  locale: ViewingLocale | null = null,
): string {
  if (viewing === null && locale === null) return text;
  const lines = [
    HEADER,
    ...(locale === null ? [] : [`language: ${locale}`]),
    ...(viewing === null
      ? []
      : [
          `space: ${oneLine(viewing.spaceName)} (spaceId: ${viewing.spaceId})`,
          // "open:", not "open page:", on purpose. The local mock model picks
          // tools by matching their name's words against the message, so a bare
          // "page" here calls readPage, createPage, updatePage and deletePage at
          // once. The id beside it already says what kind of thing this is.
          viewing.page === undefined
            ? 'open: none (the space itself is on screen)'
            : `open: ${oneLine(viewing.page.title)} (pageId: ${viewing.page.pageId})`,
        ]),
    END,
  ];
  return `${lines.join('\n')}\n${text}`;
}

/**
 * The same message with the screen block taken back off, for the transcript.
 *
 * The panel redraws a reloaded conversation from stored history, and what it
 * should show there is what the user typed — not the lines the server added on
 * the way past. The stored copy keeps them, as the record of what the agent was
 * actually asked.
 *
 * The block comes off only when the message opens with the header *and* carries
 * the end marker on a line of its own, so a message that merely mentions either
 * is returned whole.
 */
export function withoutViewing(text: string): string {
  if (!text.startsWith(`${HEADER}\n`)) return text;
  const end = text.indexOf(`\n${END}\n`);
  return end === -1 ? text : text.slice(end + END.length + 2);
}

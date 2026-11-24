/**
 * What the conversation panel is allowed to show.
 *
 * Imports nothing, because both ends of the panel need the same answer: the API
 * shapes the stored history a reload is redrawn from (`index.ts`), and the panel
 * shapes the live list the chunk stream builds (`src/components/AiAssistant.tsx`).
 * A rule applied at one end only would make a reload disagree with the screen it
 * replaced — the same argument `refusals.ts` and `model-text.ts` make.
 */

/** The part of a message these rules look at, in either representation. */
export type TranscriptMessage = { role: string; content: string };

/**
 * What an `approval` message says when the user said yes.
 *
 * Three spellings because two sources write them. The Agent block stores `yes`
 * or `trust`; the `useChat` hook puts `Approved` in the live list the moment the
 * button is pressed, before the server has been told. Anything else is a
 * discard.
 */
const APPROVED = new Set(['Approved', 'yes', 'trust']);

/**
 * Drop the reply the agent writes after the user discards a change.
 *
 * Discarding cancels the tool, but it does not end the agent's turn: the block
 * hands the model a cancelled tool call and the model writes a closing message
 * about it. That message is unwanted and was also wrong — asked to discard an
 * edit, the model explained that the user lacked permission to edit the page,
 * which was never what happened. Discarding means the request is dropped, so
 * nothing should answer it.
 *
 * The turn is still resumed rather than abandoned. The block clears a pending
 * approval only as part of resuming, so refusing to resume would leave the card
 * waiting on the next reload; the reply is produced and then not shown.
 *
 * The window opens on a run of approval messages that are all discards, and
 * closes at the next thing the user says. A run holding even one approval is not
 * a discard, so the reply about what *was* approved still comes through.
 */
export function withoutDiscardedReplies<T extends TranscriptMessage>(messages: T[]): T[] {
  const out: T[] = [];
  let discarding = false;
  let previousWasApproval = false;

  for (const message of messages) {
    if (message.role === 'approval') {
      const approved = APPROVED.has(message.content);
      discarding = previousWasApproval ? discarding && !approved : !approved;
      previousWasApproval = true;
      out.push(message);
      continue;
    }
    previousWasApproval = false;
    if (message.role === 'user') discarding = false;
    if (discarding && message.role === 'assistant') continue;
    out.push(message);
  }
  return out;
}

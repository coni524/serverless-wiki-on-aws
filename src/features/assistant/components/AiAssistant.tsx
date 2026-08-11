import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import { useChat, type ChatMessage } from '@aws-blocks/bb-agent/client';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Drawer from '@cloudscape-design/components/drawer';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { errMessage } from '@/utils/errors';
import { useLocale, useT, type Messages } from '@/lib/i18n';
// The one rule that decides what a discarded change leaves behind, reached from
// the browser so the live panel and a reloaded one agree. See the module.
import { withoutDiscardedReplies } from '../../../../aws-blocks/transcript';

/**
 * The AI assistant panel, rendered as the app layout's right-hand drawer.
 *
 * `useChat` owns the conversation: it subscribes to the Realtime channel before
 * sending — the ordering that keeps the first chunks from being dropped — and
 * turns the chunk stream into a message list. This component renders that list,
 * and adds the one thing the hook leaves to the app: the approval card for a
 * write tool the agent has paused on.
 *
 * Everything the panel can do goes through the same API as the rest of the UI,
 * so the assistant reaches exactly the pages its user does.
 *
 * The conversation is split from the panel on purpose. A drawer's content is
 * unmounted while the drawer is closed, so state held inside it would be lost
 * every time the panel is dismissed — and with no conversation list to reopen
 * from, that would strand a thread the user was in the middle of. `useAssistant`
 * is therefore called by the shell, which stays mounted, and the panel below is
 * what renders it.
 */

/** The drawer's id, shared with the shell that registers it. */
export const ASSISTANT_DRAWER_ID = 'ai-assistant';

/** One tool call waiting for the user's yes or no. */
export type PendingInterrupt = { id: string; name: string; reason?: unknown };

/** The `reason` an approval interrupt carries: which tool, and with what input. */
export type ApprovalReason = { tool?: string; input?: unknown };

/**
 * A tool's name as the reader sees it, or the raw name when it has none.
 *
 * The dictionary is passed in rather than read here, because this is called
 * from render paths in two components and the names it knows are fixed at
 * build time — a tool the dictionary has no entry for is still shown, by the
 * name the agent called it with.
 */
export const toolLabel = (t: Messages, name: string) =>
  (t.assistant.tool as Record<string, string | undefined>)[name] ?? name;

/**
 * The tools whose results change the wiki.
 *
 * Used to tell the shell when a write has actually landed, so the tree and the
 * open page are refetched. Nothing else reports it: the approval only says the
 * handler may start, and the handler runs on the server well after that.
 */
const WRITE_TOOLS = new Set(['createPage', 'updatePage', 'deletePage']);

/**
 * The screen the user has open, as the shell reads it off the route.
 *
 * Sent with every message so the assistant can act on "this page" without
 * hunting for it. The server checks the ids before it believes them.
 */
export type Viewing = { spaceId: string | null; pageId: string | null };

/**
 * The conversation, held by the shell so that closing the drawer cannot end it.
 *
 * `onWriteApplied` fires once a write tool has finished on the server. The shell
 * uses it to refetch what the write may have changed; without it the tree and
 * the open page keep showing the state from before the assistant edited them,
 * and the user has to reload the browser to see their own approved change.
 *
 * `viewing` follows the route, so it changes far more often than this hook is
 * rebuilt — the chat instance below is created once and keeps the handlers it
 * was given. It is therefore read through a ref at send time, which is also what
 * makes the message carry the page that was open when it was sent rather than
 * the one open when the conversation started.
 */
export function useAssistant({
  onWriteApplied,
  viewing,
}: { onWriteApplied?: () => void; viewing?: Viewing } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [interrupts, setInterrupts] = useState<PendingInterrupt[]>([]);
  // The name of the tool that is running, not its label: the chat instance is
  // built once and keeps the handlers it was given, so a label resolved here
  // would keep the language the conversation started in. The panel resolves it.
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Set while the turn that followed a discard is still finishing on the server.
  const [discarding, setDiscarding] = useState(false);

  // `useChat` is a factory, not a React hook: it returns a mutable instance that
  // must outlive renders, so it is built once and kept in a ref.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  const chat = () => (chatRef.current ??= createChat());

  // The chat instance is built once and keeps the handlers it was given, so the
  // callback is reached through a ref rather than captured.
  const onWriteAppliedRef = useRef(onWriteApplied);
  onWriteAppliedRef.current = onWriteApplied;

  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  // Read at send time for the same reason `viewing` is: the chat instance is
  // built once, and the reader may switch language partway through a
  // conversation. Sending it per turn is what lets the next answer come back in
  // the new language without starting the conversation over.
  const { locale } = useLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;

  // Set when a write tool starts, cleared when a result for it comes back.
  const writeRunning = useRef(false);

  function createChat() {
    return useChat({
      api: {
        createConversation: () => api.startAssistantConversation(),
        // The hook passes a channel id as the third argument; the backend keys
        // the channel on the conversation itself, so there is nothing to send.
        sendMessage: async (conversationId, message) => {
          await api.sendAssistantMessage(
            conversationId,
            message,
            {
              spaceId: viewingRef.current?.spaceId ?? null,
              pageId: viewingRef.current?.pageId ?? null,
            },
            localeRef.current,
          );
        },
        getConversation: (id) => api.getAssistantConversation(id),
        resume: async (channelId, responses, conversationId) => {
          await api.resumeAssistant(
            conversationId ?? channelId,
            responses.map((response) => ({
              interruptId: response.interruptId,
              approved: response.approved,
            })),
          );
        },
        getPendingInterrupts: (id) => api.getAssistantPendingInterrupts(id),
      },
      subscribe: async (channelId, handler) => {
        const channel = await api.getAssistantChannel(channelId);
        return channel.subscribe(handler);
      },
      onMessagesChange: (list) => setMessages(withoutDiscardedReplies([...list])),
      onLoadingChange: setLoading,
      onError: setError,
      onInterrupt: (pending) => setInterrupts(pending),
      onChunk: (chunk) => {
        // The turn that follows a discard runs to its end on the server and is
        // not shown, so nothing here should announce that it is running either.
        if (chunk.type === 'done' || chunk.type === 'error') setDiscarding(false);
        // A running tool is the only thing that explains a long silence, so it
        // is worth surfacing while the agent works.
        if (chunk.type === 'tool-call') {
          setActivity(chunk.toolName ?? '');
          if (WRITE_TOOLS.has(chunk.toolName ?? '')) writeRunning.current = true;
        }
        if (chunk.type === 'tool-result' || chunk.type === 'done' || chunk.type === 'error') {
          setActivity(null);
        }
        // Also on error and on the end of the turn: a write that failed halfway
        // can still have changed something, and a turn that ended without a
        // result chunk would otherwise leave the flag set and the screen stale.
        if (
          writeRunning.current &&
          (chunk.type === 'tool-result' || chunk.type === 'done' || chunk.type === 'error')
        ) {
          writeRunning.current = false;
          onWriteAppliedRef.current?.();
        }
      },
    });
  }

  // Drop the WebSocket subscription when the shell goes away (sign-out).
  useEffect(() => () => chatRef.current?.destroy(), []);

  // True from the moment a send is accepted until the hook has taken it over.
  // `loading` is React state, so it is a render behind: between calling
  // `sendMessage` and the re-render that reports it, a second send would pass a
  // check on `loading` alone. The hook drops that send silently — it has its own
  // `if (loading) return` — and the text would be gone with it.
  const sending = useRef(false);

  const send = async () => {
    const text = draft.trim();
    if (text === '') return;
    const instance = chat();
    // Refuse rather than queue, and leave the draft in the box so the refusal is
    // visible and the text is still there to send again.
    if (sending.current || instance.isLoading()) return;
    sending.current = true;
    setDraft('');
    setError(null);
    try {
      await instance.sendMessage(text);
    } catch (e) {
      setError(errMessage(e));
      setDraft(text);
    } finally {
      sending.current = false;
    }
  };

  /**
   * Answer the pending approvals.
   *
   * Discarding is the request being dropped, so the panel says nothing more
   * about it: `discarding` hides the progress the resumed turn would otherwise
   * report, and `withoutDiscardedReplies` hides the closing message the model
   * writes about the tool it was not allowed to run. The turn is still resumed,
   * because that is the only thing that clears the pending approval — see
   * `aws-blocks/transcript.ts`.
   */
  const respond = async (approved: boolean) => {
    const pending = interrupts;
    setInterrupts([]);
    setError(null);
    if (!approved) setDiscarding(true);
    try {
      await chat().respondToInterrupt(
        pending.map((interrupt) => ({ interruptId: interrupt.id, approved })),
      );
    } catch (e) {
      setDiscarding(false);
      setError(errMessage(e));
      setInterrupts(pending);
    }
  };

  const startOver = () => {
    chatRef.current?.destroy();
    chatRef.current = null;
    setMessages([]);
    setInterrupts([]);
    setActivity(null);
    setError(null);
    setDiscarding(false);
  };

  return {
    messages,
    // A discarded turn is still running on the server; as far as the panel is
    // concerned it ended when the user pressed the discard button.
    loading: loading && !discarding,
    interrupts,
    activity: discarding ? null : activity,
    error,
    draft,
    setDraft,
    send,
    respond,
    startOver,
  };
}

/**
 * The drawer's contents: the conversation the shell holds, and its controls.
 *
 * Wrapped in `Drawer` because `AppLayout` draws its own close button in the
 * top-right corner of the panel; `Drawer`'s `headerActions` slot is the one
 * place a button of ours can sit without landing under it.
 */
export function AiAssistant({
  messages,
  loading,
  interrupts,
  activity,
  error,
  draft,
  setDraft,
  send,
  respond,
  startOver,
}: ReturnType<typeof useAssistant>) {
  const t = useT();
  const endRef = useFollowingEnd([messages, activity, interrupts]);

  return (
    <Drawer
      header={<h2>{t.assistant.title}</h2>}
      headerActions={<Button onClick={startOver}>{t.assistant.startOver}</Button>}
      // The input belongs to the panel, not to the end of the conversation: the
      // drawer's footer keeps it at the bottom edge and out of the scroll, so
      // it is in the same place whether the thread is empty or long. The footer
      // stops sticking on its own when the panel is too short to spare the
      // room, which keeps the last messages readable.
      //
      // The approval sits in the same footer, directly above the input. A
      // decision the agent is blocked on should not be something the user can
      // scroll away from, and here it is the last thing between them and the
      // box they would type in next.
      footer={
        <SpaceBetween size="xs">
          {interrupts.length > 0 && <Approval interrupts={interrupts} respond={respond} />}
          <PromptInput
            value={draft}
            placeholder={t.assistant.inputPlaceholder}
            ariaLabel={t.assistant.inputAriaLabel}
            actionButtonIconName="send"
            actionButtonAriaLabel={t.assistant.send}
            disableActionButton={loading || draft.trim() === ''}
            maxRows={6}
            onChange={(e) => setDraft(e.detail.value)}
            onAction={() => void send()}
          />
        </SpaceBetween>
      }
    >
      <SpaceBetween size="m">
        {messages.length === 0 && (
          <Box color="text-status-inactive">{t.assistant.emptyState}</Box>
        )}

        <SpaceBetween size="xs">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </SpaceBetween>

        {activity !== null && (
          <StatusIndicator type="loading">{toolLabel(t, activity)}…</StatusIndicator>
        )}
        {loading && activity === null && (
          <StatusIndicator type="loading">{t.assistant.thinking}</StatusIndicator>
        )}
        {error !== null && <Alert type="error">{error}</Alert>}

        <div ref={endRef} />
      </SpaceBetween>
    </Drawer>
  );
}

/**
 * Keeps the end of the conversation in view.
 *
 * With the input pinned to the panel's bottom edge, the newest message is the
 * one that has to be visible above it; without this the reply lands below the
 * fold and the panel looks like it did nothing. The follow stops as soon as the
 * user scrolls up, so reading back through a thread is not interrupted by the
 * answer still streaming in, and resumes once they return to the bottom.
 */
function useFollowingEnd(deps: unknown[]) {
  const endRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  useEffect(() => {
    const scroller = scrollParent(endRef.current);
    if (scroller === null) return;
    const onScroll = () => {
      atEnd.current = distanceFromEnd(scroller) < FOLLOW_THRESHOLD;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    // The panel's own scroll, not `scrollIntoView` on the marker: the drawer
    // keeps blank space below its content, and stopping at the marker would
    // leave that gap unscrolled — enough for the check above to read as "the
    // user has scrolled up" and switch the follow off after the first message.
    const scroller = scrollParent(endRef.current);
    if (scroller !== null && atEnd.current) scroller.scrollTop = scroller.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return endRef;
}

/** How far from the bottom the panel may sit and still be counted as following. */
const FOLLOW_THRESHOLD = 80;

const distanceFromEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/** The nearest ancestor that scrolls, which for this panel is the drawer's own body. */
function scrollParent(from: HTMLElement | null): HTMLElement | null {
  for (let node = from?.parentElement ?? null; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

function Message({ message }: { message: ChatMessage }) {
  const t = useT();
  if (message.role === 'approval') {
    const approved = message.content === 'Approved' || message.content === 'yes';
    return (
      <Box color="text-status-inactive" fontSize="body-s">
        {approved ? t.assistant.approved : t.assistant.discarded}
      </Box>
    );
  }
  return (
    <Box variant="div" padding={{ vertical: 'xxs' }}>
      <Box fontSize="body-s" color="text-label">
        {message.role === 'user' ? t.assistant.you : t.assistant.assistant}
      </Box>
      {/* Plain text, not Markdown: an answer is rendered as the model wrote it,
          so nothing in a page body can smuggle markup into this panel. */}
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message.content}</span>
    </Box>
  );
}

/**
 * The decision itself, pinned above the input while a write tool waits.
 *
 * It names the operations only. What the change actually does to the page is
 * shown as a diff in the content area (`PendingChange`), which is where the room
 * for two versions of a paragraph is; a 420px panel could only repeat the tool's
 * arguments. So the user reads the change on the left and answers here, and
 * there is one set of buttons for the one question.
 */
function Approval({
  interrupts,
  respond,
}: {
  interrupts: PendingInterrupt[];
  respond: (approved: boolean) => void;
}) {
  const t = useT();
  return (
    <Alert type="warning" header={t.assistant.approvalHeader}>
      <SpaceBetween size="xs">
        <SpaceBetween size="xxs">
          {interrupts.map((interrupt) => {
            const reason = (interrupt.reason ?? {}) as ApprovalReason;
            return <Box key={interrupt.id}>{toolLabel(t, reason.tool ?? interrupt.name)}</Box>;
          })}
          <Box color="text-status-inactive" fontSize="body-s">
            {t.assistant.approvalHint}
          </Box>
        </SpaceBetween>
        <SpaceBetween size="xs" direction="horizontal">
          <Button variant="primary" onClick={() => respond(true)}>
            {t.assistant.approve}
          </Button>
          <Button onClick={() => respond(false)}>{t.assistant.discard}</Button>
        </SpaceBetween>
      </SpaceBetween>
    </Alert>
  );
}

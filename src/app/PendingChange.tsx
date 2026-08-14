import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  colorBackgroundStatusError,
  colorBackgroundStatusSuccess,
  colorBorderDividerDefault,
  colorBorderStatusError,
  colorBorderStatusSuccess,
  colorTextBodySecondary,
  fontFamilyMonospace,
} from '@cloudscape-design/design-tokens';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import type { PageDetail } from '@/types/api';
import { pageQuery } from '@/features/pages/api/page-cache';
import { spaceQuery } from '@/features/spaces/api/space-cache';
// The one repair the write path applies to a model-composed body, reached from
// the browser so this card shows the text that would actually be stored. See
// `aws-blocks/model-text.ts` for why the rule lives in one place.
import { unescapeModelNewlines } from '../../aws-blocks/model-text';
import {
  countChanges,
  diffLines,
  tooLargeToDiff,
  type DiffLine,
  type DiffSegment,
} from '@/lib/diff';
import { toolLabel, type ApprovalReason, type PendingInterrupt } from '@/features/assistant/components/AiAssistant';
import { useT, type Messages } from '@/lib/i18n';

/**
 * The review screen for a write the assistant is waiting on.
 *
 * The approval itself is unchanged: nothing is written until the user says yes,
 * and the handler still checks the space's `write` permission afterwards. What
 * changed is what the user is shown. The tool's input used to be printed as
 * JSON in the drawer, which for `updatePage` meant a whole replacement body as
 * one long string — a form in which a dropped word or a lost line break is
 * invisible. Here the proposed body is compared against the page's current one
 * and shown as a diff, so the user approves a change they can actually see.
 *
 * It renders in the content area rather than the drawer because that is where
 * the room is: a 420px panel cannot show two versions of a paragraph side by
 * side. The answer is given in the drawer, above the input (see `AiAssistant`),
 * so this screen shows the change and nothing that decides it — one question
 * with two sets of buttons would be two chances to answer it.
 *
 * The comparison is drawn from the page as it is *now*, fetched when this panel
 * opens. If the page changed after the model read it, the diff shows the change
 * against the current text, which is the version the write would actually
 * overwrite — the honest thing to put in front of someone about to approve it.
 */
export function PendingChange({ interrupts }: { interrupts: PendingInterrupt[] }) {
  const t = useT();
  return (
    <ContentLayout
      header={
        <Header variant="h1" description={t.assistant.reviewDescription}>
          {t.assistant.reviewHeading}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {interrupts.map((interrupt) => (
          <OneChange key={interrupt.id} interrupt={interrupt} />
        ))}
      </SpaceBetween>
    </ContentLayout>
  );
}

/** One pending tool call, drawn as whatever kind of change it is. */
function OneChange({ interrupt }: { interrupt: PendingInterrupt }) {
  const t = useT();
  const reason = (interrupt.reason ?? {}) as ApprovalReason;
  const tool = reason.tool ?? interrupt.name;
  const input = (reason.input ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'createPage':
      return <CreateChange input={input} />;
    case 'updatePage':
      return <UpdateChange input={input} />;
    case 'deletePage':
      return <DeleteChange input={input} />;
    default:
      // No read tool asks for approval, so this is only reachable if a future
      // tool does. Showing its raw input is the honest fallback: better a wall
      // of JSON than a confident summary of a call this screen does not know.
      return (
        <Container header={<Header variant="h2">{toolLabel(t, tool)}</Header>}>
          <Box variant="code" fontSize="body-s">
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {JSON.stringify(input, null, 2)}
            </span>
          </Box>
        </Container>
      );
  }
}

/** A new page: every line is an addition, because there is nothing to compare to. */
function CreateChange({ input }: { input: Record<string, unknown> }) {
  const t = useT();
  const title = str(input.title);
  const body = bodyStr(input.body);
  const spaceId = str(input.spaceId);
  const parentPageId = str(input.parentPageId);

  const space = useQuery({ ...spaceQuery(spaceId), enabled: spaceId !== '' });
  // Through the cache like every other read, even though only the title is used
  // here: the parent is a page the user just had open in the tree, so its stamp
  // is held and the server skips the S3 read.
  const parent = useQuery({ ...pageQuery(parentPageId), enabled: parentPageId !== '' });

  return (
    <Container
      header={
        <Header variant="h2" description={placement(t, space.data?.name ?? null, parent.data)}>
          {t.assistant.createHeading(title)}
        </Header>
      }
    >
      <Diff
        lines={body === '' ? [] : allLines(body, 'add')}
        emptyLabel={t.assistant.bodyEmpty}
      />
    </Container>
  );
}

/** An edit: the page as it stands now, against the body the model wrote. */
function UpdateChange({ input }: { input: Record<string, unknown> }) {
  const t = useT();
  const pageId = str(input.pageId);
  // Through the cache, so the stamp is sent and an unchanged body is not
  // re-read from S3. This still asks the server every time — a diff shown
  // against a body nobody confirmed would be worse than a slow one.
  const page = useQuery(pageQuery(pageId));

  if (page.error !== null) {
    return <ErrorText>{t.assistant.loadCurrentFailed(errMessage(page.error))}</ErrorText>;
  }
  if (page.data === undefined) return <Loading label={t.assistant.loadingCurrent} />;

  const current = page.data;
  // An omitted field means "leave it alone", so the current value stands in.
  const nextTitle = input.title === undefined ? current.title : str(input.title);
  const nextBody = input.body === undefined ? current.body : bodyStr(input.body);

  return (
    <Container
      header={
        <Header variant="h2" description={breadcrumbText(t, current)}>
          {t.assistant.updateHeading(current.title)}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {nextTitle !== current.title && (
          <Box>
            <Box fontSize="body-s" color="text-label">
              {t.assistant.titleField}
            </Box>
            <Diff
              lines={[
                { kind: 'remove', text: current.title },
                { kind: 'add', text: nextTitle },
              ]}
              emptyLabel={t.assistant.titleUnchanged}
            />
          </Box>
        )}
        <BodyDiff before={current.body} after={nextBody} />
      </SpaceBetween>
    </Container>
  );
}

/** A delete: the page's own text, every line marked as going away. */
function DeleteChange({ input }: { input: Record<string, unknown> }) {
  const t = useT();
  const pageId = str(input.pageId);
  // Through the cache, so the stamp is sent and an unchanged body is not
  // re-read from S3. This still asks the server every time — a diff shown
  // against a body nobody confirmed would be worse than a slow one.
  const page = useQuery(pageQuery(pageId));

  if (page.error !== null) {
    return <ErrorText>{t.assistant.loadTargetFailed(errMessage(page.error))}</ErrorText>;
  }
  if (page.data === undefined) return <Loading label={t.assistant.loadingTarget} />;

  return (
    <Container
      header={
        <Header variant="h2" description={breadcrumbText(t, page.data)}>
          {t.assistant.deleteHeading(page.data.title)}
        </Header>
      }
    >
      <Diff
        lines={page.data.body === '' ? [] : allLines(page.data.body, 'remove')}
        emptyLabel={t.assistant.bodyEmptyPage}
      />
    </Container>
  );
}

/** The body comparison, or a note when there is nothing to compare. */
function BodyDiff({ before, after }: { before: string; after: string }) {
  const t = useT();
  if (before === after) {
    return <Box color="text-status-inactive">{t.assistant.bodyUnchanged}</Box>;
  }
  if (tooLargeToDiff(before, after)) {
    // Rather than a diff nobody could read, show what the body would become and
    // say plainly that the comparison was skipped.
    return (
      <SpaceBetween size="xs">
        <Box color="text-status-inactive">{t.assistant.bodyTooLarge}</Box>
        <Diff lines={allLines(after, 'add')} emptyLabel={t.assistant.bodyWillBeEmpty} />
      </SpaceBetween>
    );
  }

  const lines = diffLines(before, after);
  const { added, removed } = countChanges(lines);
  return (
    <SpaceBetween size="xs">
      <Box fontSize="body-s" color="text-label">
        {t.assistant.bodyChanges(added, removed)}
      </Box>
      <Diff lines={lines} emptyLabel={t.assistant.bodyUnchanged} />
    </SpaceBetween>
  );
}

/**
 * Cloudscape's own values for the colours the diff needs.
 *
 * Cloudscape has no diff component, so the rows are this app's own CSS — but
 * their colours should not be. Each token is a `var(--…)` reference that the
 * global stylesheet resolves for whichever theme is in force, so handing them to
 * the stylesheet as custom properties keeps the choice of colour with
 * Cloudscape and only the layout here.
 */
const DIFF_TOKENS = {
  '--diff-font': fontFamilyMonospace,
  '--diff-border': colorBorderDividerDefault,
  '--diff-add-background': colorBackgroundStatusSuccess,
  '--diff-add-border': colorBorderStatusSuccess,
  '--diff-remove-background': colorBackgroundStatusError,
  '--diff-remove-border': colorBorderStatusError,
  '--diff-same-text': colorTextBodySecondary,
} as CSSProperties;

function Diff({ lines, emptyLabel }: { lines: DiffLine[]; emptyLabel: string }) {
  if (lines.length === 0) return <Box color="text-status-inactive">{emptyLabel}</Box>;
  return (
    <div className="diff" style={DIFF_TOKENS}>
      {lines.map((line, index) => (
        <DiffRow key={index} line={line} />
      ))}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
  return (
    <div className={`diff-line diff-${line.kind}`}>
      <span className="diff-marker" aria-hidden="true">
        {marker}
      </span>
      {/* An empty line still needs its height, or a blank line added to a body
          collapses and the count above stops matching what is on screen. */}
      <span className="diff-text">
        {line.segments === undefined ? (
          line.text === '' ? (
            ' '
          ) : (
            line.text
          )
        ) : (
          <Segments segments={line.segments} />
        )}
      </span>
    </div>
  );
}

/**
 * A replaced line, with the characters that differ picked out.
 *
 * `mark` rather than a coloured span: which part of the line the edit touched is
 * information, so it belongs in the markup where a screen reader reaches it, not
 * only in a background colour.
 */
function Segments({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.changed ? (
          <mark key={index} className="diff-changed">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Every line of `text` as the same kind of change. */
function allLines(text: string, kind: DiffLine['kind']): DiffLine[] {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => ({ kind, text: line }));
}

/** Where a new page would land, as far as it is known. */
function placement(t: Messages, spaceName: string | null, parent: PageDetail | undefined): string {
  if (parent !== undefined) return t.assistant.underParent(parent.title);
  if (spaceName !== null) return t.assistant.underSpace(spaceName);
  return '';
}

/** A page's ancestors as a single line, for the panel's subtitle. */
function breadcrumbText(t: Messages, page: PageDetail): string {
  return page.breadcrumb.map((item) => item.title).join(t.assistant.breadcrumbSeparator);
}

/** A field of the tool input as a string, tolerating anything the model sent. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A body field of the tool input, repaired exactly as the write path repairs it. */
function bodyStr(value: unknown): string {
  return unescapeModelNewlines(str(value));
}

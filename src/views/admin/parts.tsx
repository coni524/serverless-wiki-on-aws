import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useT } from '../../i18n';
import { errMessage, isTypedKey, type DirectoryUser, type Group } from '../../lib';

/**
 * Pieces the four management screens share.
 *
 * They all do the same two things: run one write and report what it said, and
 * ask before something is destroyed. Keeping both here is what stops each screen
 * from inventing its own idea of "busy" and its own wording for a refusal — and
 * the refusals matter, because the server's guards (the last administrator, a
 * system group, the default group) are the only place those rules live.
 */

// ─── Running one write ───────────────────────────────────────────────────────

export interface Action {
  busy: boolean;
  error: string | null;
  /** Run the write, then `onDone` only if it succeeded. */
  run: (write: () => Promise<unknown>, onDone?: () => void) => void;
  clearError: () => void;
}

export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback((write: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setError(null);
    write()
      .then(() => {
        if (!live.current) return;
        setBusy(false);
        onDone?.();
      })
      .catch((e) => {
        if (!live.current) return;
        // Kept on screen rather than logged: a refusal here is the permission
        // model talking, and the administrator is the person who has to read it.
        setError(errMessage(e));
        setBusy(false);
      });
  }, []);

  return { busy, error, run, clearError: () => setError(null) };
}

/** The error of a write, where the screen puts it. Renders nothing when clear. */
export function ActionError({ action }: { action: Action }) {
  if (action.error === null) return null;
  return (
    <Alert type="error" dismissible onDismiss={action.clearError}>
      {action.error}
    </Alert>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────

/**
 * Confirm something that cannot be undone.
 *
 * The server refuses the removals that would leave the Wiki unmanageable, so
 * this is not a safety net — it is there because a delete here takes grants away
 * from everyone who reached them through the group.
 */
export function ConfirmModal({
  header,
  confirmLabel,
  action,
  onConfirm,
  onDismiss,
  children,
}: {
  header: string;
  /** Defaults to the word for a delete, which is what every caller confirms. */
  confirmLabel?: string;
  action: Action;
  onConfirm: () => void;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Modal
      visible
      header={header}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button disabled={action.busy} onClick={onDismiss}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" loading={action.busy} onClick={onConfirm}>
              {confirmLabel ?? t.common.delete}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {children}
        <ActionError action={action} />
      </SpaceBetween>
    </Modal>
  );
}

/** Create a user group or a role group: the two take the same two fields. */
export function CreateGroupModal({
  header,
  nameLabel,
  onCreate,
  onDismiss,
}: {
  header: string;
  nameLabel: string;
  onCreate: (input: { name: string; description: string }) => Promise<unknown>;
  onDismiss: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const action = useAction();
  const ready = name.trim() !== '' && !action.busy;
  const create = () => action.run(() => onCreate({ name: name.trim(), description: description.trim() }));

  return (
    <Modal
      visible
      header={header}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button disabled={action.busy} onClick={onDismiss}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" loading={action.busy} disabled={!ready} onClick={create}>
              {t.common.create}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={action.error ?? undefined}>
        <SpaceBetween size="m">
          <FormField label={nameLabel}>
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.detail.value)}
              onKeyDown={(e) => {
                // `isTypedKey` keeps the Enter that confirms a Japanese
                // conversion from creating the group mid-word.
                if (!isTypedKey(e.detail)) return;
                if (e.detail.key === 'Enter' && ready) create();
              }}
            />
          </FormField>
          <FormField label={t.admin.shared.description} description={t.admin.shared.optional}>
            <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}

// ─── The user directory ──────────────────────────────────────────────────────

export interface Directory {
  users: DirectoryUser[];
  /** Non-null while more rows remain; pass it back through `loadMore()`. */
  cursor: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Accounts known to the Wiki, filtered by the start of the address.
 *
 * Paging is keyset (`findUsers` settled that contract): each page carries the
 * cursor for the next, and pages are appended rather than replaced, so the
 * screen grows downward instead of flipping. A run counter discards a response
 * that lands after the prefix changed — the reply to an abandoned filter must
 * never overwrite the current one.
 */
export function useDirectory(prefix: string): Directory {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const fetchPage = useCallback(
    (from: string | null) => {
      const token = ++run.current;
      setLoading(true);
      setError(null);
      api
        .findUsers(prefix === '' ? null : prefix, from)
        .then((result) => {
          if (token !== run.current) return;
          setUsers((previous) => (from === null ? result.users : [...previous, ...result.users]));
          setCursor(result.nextCursor);
          setLoading(false);
        })
        .catch((e) => {
          if (token !== run.current) return;
          setError(errMessage(e));
          setLoading(false);
        });
    },
    [prefix],
  );

  useEffect(() => fetchPage(null), [fetchPage]);

  return {
    users,
    cursor,
    loading,
    error,
    loadMore: () => fetchPage(cursor),
    reload: () => fetchPage(null),
  };
}

/** The "load the next page" row under a directory listing. */
export function LoadMore({ directory }: { directory: Directory }) {
  const t = useT();
  if (directory.cursor === null) return null;
  return (
    <Box textAlign="center" padding={{ top: 'xs' }}>
      <Button loading={directory.loading} onClick={directory.loadMore}>
        {t.admin.shared.loadMore}
      </Button>
    </Box>
  );
}

// ─── Group labels ────────────────────────────────────────────────────────────

/** The badges that say a group is not an ordinary one. */
export function GroupBadges({ group }: { group: Group }) {
  const t = useT();
  if (!group.system && !group.global) return null;
  return (
    <SpaceBetween size="xxs" direction="horizontal">
      {group.global && <Badge color="red">{t.admin.shared.globalBadge}</Badge>}
      {group.system && <Badge color="grey">{t.admin.shared.systemBadge}</Badge>}
    </SpaceBetween>
  );
}

/** A group's name, for a row that holds only its id (a deleted group included). */
export function groupName(groups: Group[], id: string): string {
  return groups.find((group) => group.id === id)?.name ?? id;
}

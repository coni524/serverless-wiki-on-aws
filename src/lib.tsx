import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useT } from './i18n';

// ─── Types ───────────────────────────────────────────────────────────────────
// Derived straight from the typed API client so the frontend never restates a
// backend shape. If a method's return type changes, these follow.

export type Me = Awaited<ReturnType<typeof api.me>>;
export type Space = Awaited<ReturnType<typeof api.mySpaces>>[number];
export type SpaceDetail = Awaited<ReturnType<typeof api.getSpace>>;
export type Permission = Space['permission'];
export type Page = Awaited<ReturnType<typeof api.listChildPages>>['items'][number];
export type PageDetail = Awaited<ReturnType<typeof api.getPage>>;
export type FolderDetail = Awaited<ReturnType<typeof api.getFolder>>;
/** Which of the two node kinds the tree holds. */
export type NodeKind = Page['kind'];
export type Attachment = Awaited<ReturnType<typeof api.listAttachments>>['items'][number];
export type SearchItem = Awaited<ReturnType<typeof api.search>>['items'][number];
/** User groups and role groups come back in one shape, so one type covers both. */
export type Group = Awaited<ReturnType<typeof api.listUserGroups>>[number];
export type DirectoryUser = Awaited<ReturnType<typeof api.findUsers>>['users'][number];
export type Grant = Awaited<ReturnType<typeof api.listRoleGroupGrants>>[number];
/** Every space, as only a global administrator sees them: no permission column. */
export type AdminSpace = Awaited<ReturnType<typeof api.listSpaces>>[number];
/**
 * The level a grant carries. Distinct from `Permission`, which is what the
 * caller holds on a space and is therefore `undefined` when they hold nothing.
 */
export type GrantLevel = Grant['permission'];

/** `write` and `admin` both allow editing; `read` does not. */
export function canWrite(permission: Permission): boolean {
  return permission === 'write' || permission === 'admin';
}

/**
 * Names, compared the way a file manager compares them: case and kana folded
 * together, and digit runs read as numbers so `Page 2` precedes `Page 10`.
 *
 * The locale is the reader's own rather than a fixed `ja`. This order is drawn
 * on screen and never stored, so two readers seeing their own locale's order is
 * the same thing Obsidian does with the vault beside it.
 *
 * It is the browser's locale, not the language the screen is set to. Switching
 * the screen to English changes the words around the tree, not which name the
 * reader expects to find first — that follows from the alphabet they read
 * names in, which is what the browser is already reporting.
 */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Siblings in the order the screen shows them: folders first, then pages, each
 * by name.
 *
 * `position` decides only between two names the collator calls equal — a folder
 * and a page may share a name, and so may two titles differing in case alone.
 * Without that tiebreak the order of such a pair would be whatever the sort
 * happened to do, which changes as siblings arrive.
 *
 * Sorts a copy. The caller's array is the accumulated pages of a level, and the
 * next page of results appends to it.
 */
export function sortSiblings<T extends Pick<Page, 'kind' | 'title' | 'position'>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    const name = byName.compare(a.title, b.title);
    if (name !== 0) return name;
    return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
  });
}

/**
 * Whether a key press is the user pressing that key, rather than a step of an
 * IME (input method editor) conversion.
 *
 * Japanese input confirms a conversion candidate with Enter, and the browser
 * reports that press as an ordinary `keydown` on the way. A handler that submits
 * on Enter would therefore submit a title the user is still composing. Presses
 * inside a conversion carry `isComposing`; the Enter that closes the conversion
 * is not reported consistently across browsers, but it still carries the legacy
 * `keyCode` 229 that means "the IME handled this", so both are checked.
 */
export function isTypedKey(detail: { isComposing: boolean; keyCode: number }): boolean {
  return !detail.isComposing && detail.keyCode !== 229;
}

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

// ─── Async data hook ─────────────────────────────────────────────────────────

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetch; useful after a mutation. */
  reload: () => void;
}

/**
 * Run an async fetch and track its state, cancelling a result that lands after
 * the inputs changed or the component unmounted. `reload()` forces a re-fetch.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((result) => {
        if (!live) return;
        setData(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(errMessage(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

// ─── Small presentational atoms ──────────────────────────────────────────────

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return <StatusIndicator type="loading">{label ?? t.common.loading}</StatusIndicator>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  return <Alert type="error">{children}</Alert>;
}

/** Bytes as a short human-readable size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

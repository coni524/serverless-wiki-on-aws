import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { api } from 'aws-blocks';
import {
  colorBackgroundItemSelected,
  colorBackgroundStatusError,
  colorBackgroundStatusSuccess,
  colorBorderItemFocused,
} from '@cloudscape-design/design-tokens';
import { useQueries } from '@tanstack/react-query';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Icon from '@cloudscape-design/components/icon';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import TreeView from '@cloudscape-design/components/tree-view';
import TruncatedText from '@cloudscape-design/components/truncated-text';
import { ErrorText } from '@/components/ui';
import { PAGE_HAS_CHILDREN_ERROR, errMessage, errName } from '@/utils/errors';
import { isTypedKey } from '@/utils/ime';
import type { NodeKind, Page } from '@/types/api';
import { sortSiblings } from '@/features/pages/utils/sort';
import {
  ROOT_LEVEL,
  loadMoreTreeLevel,
  noteCreatedNode,
  noteDeletedNode,
  noteRenamedNode,
  treeLevelQuery,
  type Level,
} from '@/features/pages/api/page-cache';
import type { PageMove } from '@/features/pages/hooks/use-page-move';
import { useT } from '@/lib/i18n';
import { hrefNode, hrefSpace, navigate } from '@/lib/router';

// A hard cap on how deep the tree will render. Real trees cannot exceed the
// 10-level page-depth limit, but a cycle introduced by two concurrent
// cross-parent moves via the API/MCP can produce a `breadcrumb` that repeats
// ids — which would make the expanded path recurse forever and crash the tab.
// The tree render therefore has to be depth-bounded; this is that bound, set
// above any legitimate depth so real content is intact.
const MAX_TREE_DEPTH = 20;

/** How long a drag rests on a collapsed folder before the folder unfolds itself. */
const SPRING_MS = 600;

/** The key the level map uses for the space root, which has no parent page id. */
const ROOT = ROOT_LEVEL;

/**
 * The expanded set, kept per space in localStorage so a reload puts the tree
 * back the way the reader left it — the same deal the panel width already has.
 * Ids of nodes that have since been deleted are harmless: a node no listing
 * returns has no row to unfold, and the entry is dropped the next time the set
 * is written.
 */
const expandedStorageKey = (spaceId: string) => `sl-wiki:tree-expanded:${spaceId}`;

function readStoredExpanded(spaceId: string): string[] {
  try {
    const raw = localStorage.getItem(expandedStorageKey(spaceId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function storeExpanded(spaceId: string, expanded: string[]): void {
  try {
    localStorage.setItem(expandedStorageKey(spaceId), JSON.stringify(expanded));
  } catch {
    // Storage full or blocked: the tree still works, it just forgets on reload.
  }
}

/**
 * The row menu's trigger: three dots laid out horizontally, centred in the row.
 *
 * Cloudscape's own `ellipsis` icon stacks its dots vertically, which reads as a
 * different control from the one every wiki and note app puts at the end of a
 * tree row. The geometry and the `filled no-stroke` classes are copied from the
 * generated icon set, so it inherits size and colour like a built-in icon.
 */
const HORIZONTAL_ELLIPSIS = (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">
    <circle cx="2.5" cy="8" r="1.5" className="filled no-stroke" />
    <circle cx="8" cy="8" r="1.5" className="filled no-stroke" />
    <circle cx="13.5" cy="8" r="1.5" className="filled no-stroke" />
  </svg>
);

/**
 * What is about to be created and where. `parentPageId` is `null` for the space
 * root, and it always names a folder otherwise: a page cannot hold children,
 * so no page row offers this.
 */
export type NewNodeTarget = { parentPageId: string | null; kind: NodeKind };

/**
 * What the tree renders. Only `page` nodes come from the API; the others are
 * the tree's own rows — a stand-in that keeps a node expandable before its
 * children are known, the row that fetches the next slice of a long level, and
 * the row that takes the title of a page about to be created.
 */
type TreeNode =
  | {
      kind: 'page';
      id: string;
      page: Page;
      parentPageId: string | null;
      /** Ancestor ids, root first — what says a drop target sits inside the dragged subtree. */
      chain: string[];
      children?: TreeNode[];
    }
  | { kind: 'pending'; id: string; message: string | null }
  | { kind: 'more'; id: string; parentPageId: string | null; cursor: string }
  | { kind: 'new'; id: string; parentPageId: string | null; nodeKind: NodeKind };

/** The node a delete is being confirmed for, and how far the dialog has got. */
type Deletion = {
  pageId: string;
  parentPageId: string | null;
  nodeKind: NodeKind;
  title: string;
  /** Set once the API has refused the delete because the node still holds children. */
  childPrompt: string | null;
  busy: boolean;
  error: string | null;
};

/**
 * A lazy page tree for one space. A level is fetched (`listChildPages`) when it
 * first appears on screen, so opening a space never pulls the whole tree. Nodes
 * on `expandPath` (the current page's ancestors, from its breadcrumb) start
 * expanded, keeping the selected page in view.
 *
 * The tree holds both kinds of node. A folder carries a folder icon
 * and is the only kind that unfolds; a page is a leaf, always. That is not a
 * rendering choice — it is the server's invariant, so the row that cannot hold
 * children does not offer to hold any.
 *
 * The tree is also where pages and folders are created, renamed, and deleted.
 * Hovering a row reveals its two controls — a menu and a plus — so
 * the actions sit on the node they act on, and the body area is left to the
 * body. Creating and renaming both happen in an input that takes the place of a
 * row, so the new node appears where it will live rather than in a form
 * somewhere else.
 *
 * Three things the shell once told this component apart by remounting it are now
 * separate: the space is the tree's identity and stays on the `key`, the current
 * page arrives as `expandPath`, and an edit made here is applied to the query
 * cache — the row that was renamed is relabelled and the row that was deleted
 * leaves, with everything else on screen left exactly as it stands.
 */
export function PageTree({
  spaceId,
  currentPageId,
  expandPath,
  editable,
  move,
  newNode,
  onNewNode,
  onNewNodeEnd,
  onCreated,
}: {
  spaceId: string;
  currentPageId: string | null;
  expandPath: string[];
  /** Whether the caller holds `write` on the space. Read-only hides the controls. */
  editable: boolean;
  /** The drag-and-drop move, held by the shell because its root target is up there. */
  move: PageMove;
  /** Where the open title input sits, or `null` when nothing is being created. */
  newNode: NewNodeTarget | null;
  onNewNode: (target: NewNodeTarget) => void;
  onNewNodeEnd: () => void;
  onCreated: (nodeId: string, kind: NodeKind) => void;
}) {
  const t = useT();
  // The levels this tree is drawing, discovered by the render before this one
  // (`build` collects them). Each key is one query below; a level that folds
  // out of view drops off this list and its query unmounts, data intact.
  const [levelKeys, setLevelKeys] = useState<string[]>([ROOT]);
  const [expanded, setExpanded] = useState<string[]>(() => {
    const stored = readStoredExpanded(spaceId);
    return [...stored, ...expandPath.filter((id) => !stored.includes(id))];
  });
  useEffect(() => {
    storeExpanded(spaceId, expanded);
  }, [spaceId, expanded]);
  // Errors from the "load more" continuation, which runs outside the queries.
  const [moreErrors, setMoreErrors] = useState<Record<string, string>>({});

  // What a new `expandPath` asks for is that the current page's ancestors be
  // unfolded — not that everything else be folded back up. So the path is merged
  // into the expanded set instead of replacing it, and it is merged during
  // render, the moment the path differs from the one already taken in: this is
  // React's way of adjusting state to a changed prop, and an effect would paint
  // the tree once without the new page's ancestors before correcting itself.
  const pathKey = expandPath.join('\n');
  const [seenPathKey, setSeenPathKey] = useState(pathKey);
  if (seenPathKey !== pathKey) {
    setSeenPathKey(pathKey);
    setExpanded((prev) => {
      const missing = expandPath.filter((id) => !prev.includes(id));
      return missing.length === 0 ? prev : [...prev, ...missing];
    });
  }

  // The three row-level interactions. Each is a single-slot piece of state: one
  // title input is open at a time, and one delete is being confirmed at a time.
  const [draft, setDraft] = useState('');
  // What the input opened with. Clicking away from an untouched input closes it;
  // clicking away from one that has been typed into keeps it, so a title cannot
  // be lost to a stray click.
  const [draftInitial, setDraftInitial] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deletion | null>(null);

  // The row the drag is over right now — one row at a time, like the other
  // single-slot interactions above. Whether it lights as a target or as a
  // refusal is decided at render time (`move.canDrop`), not stored.
  const [overId, setOverId] = useState<string | null>(null);
  // A collapsed folder the drag is resting on unfolds by itself after a
  // moment, so a node can be carried into a branch nobody has opened yet.
  const springTimer = useRef<number | undefined>(undefined);
  const clearSpring = () => window.clearTimeout(springTimer.current);
  useEffect(() => clearSpring, []);

  // One query per level on screen, shared with the folder screen — both ask the
  // same parent for the same listing (`treeLevelQuery`). Refetch dedup and the
  // discard of answers that outlive a refetch are Query's own bookkeeping now.
  const levelResults = useQueries({
    queries: levelKeys.map((key) => treeLevelQuery(spaceId, key === ROOT ? null : key)),
  });
  const levels = new Map<string, { data: Level | undefined; error: string | undefined }>();
  levelKeys.forEach((key, index) => {
    const result = levelResults[index];
    levels.set(key, {
      data: result.data,
      error: result.error == null ? undefined : errMessage(result.error),
    });
  });

  /** Fetch the next slice of a long level, and report where it failed if it did. */
  const loadMore = async (parentPageId: string | null, cursor: string) => {
    const key = parentPageId ?? ROOT;
    try {
      await loadMoreTreeLevel(spaceId, parentPageId, cursor);
      setMoreErrors(({ [key]: _dropped, ...rest }) => rest);
    } catch (e) {
      setMoreErrors((prev) => ({ ...prev, [key]: errMessage(e) }));
    }
  };

  // A child is being created under a collapsed folder: unfold it, or the input
  // would be typed into a row nobody can see. Unfolding is all this has to do —
  // the level behind it is fetched because it is now on screen.
  const newParent = newNode?.parentPageId ?? null;
  useEffect(() => {
    if (newParent === null) return;
    setExpanded((prev) => (prev.includes(newParent) ? prev : [...prev, newParent]));
  }, [newParent]);

  // A create input has just opened somewhere: empty it, and close a rename that
  // was open. This is an effect rather than part of the handler that starts a
  // create, because a create can also be started from outside this component —
  // the open folder's own buttons aim the input at that folder (`App`) — and
  // that path never runs a handler in here. Left to the handler, the name typed
  // into the previous input would still be sitting in the new one.
  const newKey = newNode === null ? null : `${newNode.parentPageId ?? ROOT}#${newNode.kind}`;
  useEffect(() => {
    if (newKey === null) return;
    setRenaming(null);
    setDraft('');
    setDraftInitial('');
    setDraftError(null);
  }, [newKey]);

  const startRename = (page: Page) => {
    onNewNodeEnd();
    setDraft(page.title);
    setDraftInitial(page.title);
    setDraftError(null);
    setRenaming(page.pageId);
  };

  const cancelDraft = () => {
    setDraftError(null);
    setRenaming(null);
    onNewNodeEnd();
  };

  const create = async (parentPageId: string | null, kind: NodeKind) => {
    const title = draft.trim();
    if (title === '' || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    const input = {
      spaceId,
      ...(parentPageId === null ? {} : { parentPageId }),
      title,
    };
    try {
      // Two calls, because they are two kinds of node and only one of them has
      // a body to create. What follows is the same either way: the
      // caller decides where the new node opens.
      const created =
        kind === 'folder'
          ? (await api.createFolder(input)).folderId
          : (await api.createPage(input)).pageId;
      onNewNodeEnd();
      noteCreatedNode(spaceId, parentPageId);
      onCreated(created, kind);
    } catch (e) {
      setDraftError(errMessage(e));
    } finally {
      setDraftBusy(false);
    }
  };

  const rename = async (page: Page, parentPageId: string | null) => {
    const title = draft.trim();
    if (title === '' || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      // A folder has no body, so it has its own call rather than a patch of a
      // page: `updatePage` would refuse the id outright.
      if (page.kind === 'folder') await api.renameFolder(page.pageId, title);
      else await api.updatePage(page.pageId, { title });
      setRenaming(null);
      // Not just the tree label: the open page carries the same title in its
      // heading, and the pages under a renamed folder carry it in their
      // breadcrumbs.
      noteRenamedNode({ spaceId, pageId: page.pageId, parentPageId, title });
    } catch (e) {
      setDraftError(errMessage(e));
    } finally {
      setDraftBusy(false);
    }
  };

  const runDelete = async (children: 'reject' | 'cascade' | 'reparent') => {
    if (deleting === null) return;
    const target = deleting;
    setDeleting({ ...target, busy: true, error: null });
    try {
      if (target.nodeKind === 'folder') await api.deleteFolder(target.pageId, children);
      else await api.deletePage(target.pageId, children);
      setDeleting(null);
      // The node that was open may be the one just deleted, or a descendant of
      // it that went with a cascade. Either way its route is now a dead end, so
      // leave for the parent — and leave *before* the cache drops what that
      // route was showing, or the view would spend a frame asking for a node
      // that is gone. A parent that is drawn in this tree is a folder: nothing
      // else is unfolded.
      if (target.pageId === currentPageId || expandPath.includes(target.pageId)) {
        navigate(
          target.parentPageId === null
            ? hrefSpace(spaceId)
            : hrefNode(spaceId, target.parentPageId, 'folder'),
        );
      }
      noteDeletedNode({
        spaceId,
        pageId: target.pageId,
        parentPageId: target.parentPageId,
        children,
      });
    } catch (e) {
      // The API refuses a node that still holds children with a structured error
      // name; turn that into an explicit choice rather than a dead end. The name
      // drives the decision — the count is only parsed from the message for
      // display.
      const message = errMessage(e);
      if (children === 'reject' && errName(e) === PAGE_HAS_CHILDREN_ERROR) {
        const count = /(\d+)/.exec(message)?.[1];
        setDeleting({
          ...target,
          busy: false,
          error: null,
          childPrompt: t.space.deleteChildPrompt(target.nodeKind, count ?? null),
        });
      } else {
        setDeleting({ ...target, busy: false, error: message });
      }
    }
  };

  /**
   * Materialise the visible tree, and collect into `visited` the key of every
   * level it drew — that list is what the queries above are made from, so "a
   * level is fetched when it appears on screen" stays the whole rule. Recursion
   * follows expanded nodes only, and stops at the depth cap or at an id already
   * on the current path, so cyclic data cannot loop (see MAX_TREE_DEPTH).
   *
   * The first paint, a toggle, a page opened from a link, and a reset all reach
   * the same list, so none of them needs a fetch of its own — and a level
   * nothing is showing, such as a branch left expanded under a page that has
   * since been deleted, is never asked for.
   */
  const build = (
    parentPageId: string | null,
    depth: number,
    ancestors: string[],
    visited: string[],
  ): TreeNode[] => {
    const key = parentPageId ?? ROOT;
    visited.push(key);
    const error = levels.get(key)?.error;
    if (error !== undefined) return [{ kind: 'pending', id: `${key}#error`, message: error }];

    const level = levels.get(key)?.data;
    if (level === undefined) {
      return [{ kind: 'pending', id: `${key}#loading`, message: null }];
    }

    // Sorted here rather than where the level is stored, so that the next page
    // of results appends to what arrived before it and the whole level is put
    // back in order.
    const nodes: TreeNode[] = sortSiblings(level.items).map((page) => {
      // Whether this node has children at all: only a folder can, and
      // for a folder the answer comes from the level below it once that has been
      // fetched, and from the flag its listing carried until then. Either way the
      // answer is already here, with no request of its own.
      const below = levels.get(page.pageId)?.data;
      const hasChildren =
        page.kind === 'folder' && (below === undefined ? page.hasChildren : below.items.length > 0);
      // A node with no children is never unfolded, even while it sits on
      // `expandPath`. Opening a leaf page puts its own id on that path, and
      // unfolding it would draw a toggle and a loading row for a level that
      // comes back empty — an arrow that appears on click and vanishes a moment
      // later.
      const open =
        hasChildren &&
        expanded.includes(page.pageId) &&
        depth < MAX_TREE_DEPTH &&
        !ancestors.includes(page.pageId);
      const children = open
        ? build(page.pageId, depth + 1, [...ancestors, page.pageId], visited)
        : collapsedChildren(page, hasChildren);
      return {
        kind: 'page',
        id: page.pageId,
        page,
        parentPageId,
        chain: ancestors,
        // The title input for a new child is a child row of the folder it is
        // being created under, so it appears exactly where the node will.
        children:
          newNode?.parentPageId === page.pageId
            ? [...(open ? (children ?? []) : []), newRow(newNode)]
            : children,
      };
    });

    if (level.cursor !== null) {
      nodes.push({ kind: 'more', id: `${key}#more`, parentPageId, cursor: level.cursor });
    }
    if (parentPageId === null && newNode?.parentPageId === null) nodes.push(newRow(newNode));
    return nodes;
  };

  const newRow = (target: NewNodeTarget): TreeNode => ({
    kind: 'new',
    id: `${target.parentPageId ?? ROOT}#new`,
    parentPageId: target.parentPageId,
    nodeKind: target.kind,
  });

  /**
   * What a collapsed node reports as its children: a stand-in row when the node
   * holds children, nothing when it holds none.
   *
   * The stand-in is what makes `TreeView` draw the expand toggle before the
   * level behind it has been fetched — the row is replaced by the real children
   * once the toggle is used. A node with no children returns `undefined` and is
   * drawn as a leaf, with no toggle: an arrow on every row would promise a level
   * that is not there. Every page is a leaf by that rule.
   */
  const collapsedChildren = (page: Page, hasChildren: boolean): TreeNode[] | undefined =>
    hasChildren ? [{ kind: 'pending', id: `${page.pageId}#loading`, message: null }] : undefined;

  /** The input shared by "create" and "rename", as a row of the tree. */
  const titleInput = (label: string, onCommit: () => void) => (
    <SpaceBetween size="xxs">
      <Input
        value={draft}
        autoFocus
        disabled={draftBusy}
        placeholder={label}
        ariaLabel={label}
        onChange={(e) => setDraft(e.detail.value)}
        onKeyDown={(e) => {
          // While a Japanese conversion is open, Enter and Escape belong to the
          // IME: Enter confirms the candidate and Escape cancels it. Committing
          // the page here would create it from a half-typed title.
          if (!isTypedKey(e.detail)) return;
          if (e.detail.key === 'Enter') onCommit();
          // Escape leaves the tree as it was. Cloudscape's input would otherwise
          // just clear itself and keep the row open.
          if (e.detail.key === 'Escape') cancelDraft();
        }}
        onBlur={() => {
          // Untouched and nothing in flight: the row was opened by mistake, so
          // clicking away closes it. An edited draft stays put instead.
          if (draft.trim() === draftInitial.trim() && !draftBusy) cancelDraft();
        }}
      />
      {draftError !== null && <StatusIndicator type="error">{draftError}</StatusIndicator>}
    </SpaceBetween>
  );

  const visited: string[] = [];
  const roots = build(null, 0, [], visited);

  // Hand the render's level list to the queries above. The list is compared as
  // JSON rather than as joined keys because `ROOT` is the empty string: joined,
  // "no levels" and "the space root" are the same text.
  const visitedKey = JSON.stringify(visited);
  useEffect(() => {
    const next: string[] = JSON.parse(visitedKey);
    setLevelKeys((prev) =>
      prev.length === next.length && prev.every((key, i) => key === next[i]) ? prev : next,
    );
  }, [visitedKey]);

  const tree =
    roots.length === 1 && roots[0].kind === 'pending' && roots[0].message === null ? (
      <StatusIndicator type="loading">{t.common.loading}</StatusIndicator>
    ) : levels.get(ROOT)?.data?.items.length === 0 && newNode === null ? (
      <Box color="text-status-inactive">{t.space.treeEmpty}</Box>
    ) : (
      <TreeView
        items={roots}
        ariaLabel={t.space.treeLabel}
        connectorLines="vertical"
        expandedItems={expanded}
        getItemId={(node) => node.id}
        getItemChildren={(node) => (node.kind === 'page' ? node.children : undefined)}
        // Recording the toggle is the whole handler: the level behind a node
        // that has just been unfolded is fetched because the next render draws
        // it (see `build`).
        onItemToggle={({ detail }) => {
          setExpanded((prev) =>
            detail.expanded ? [...prev, detail.id] : prev.filter((id) => id !== detail.id),
          );
        }}
        renderItem={(node) => {
          if (node.kind === 'pending') {
            return {
              content:
                node.message === null ? (
                  <StatusIndicator type="loading">{t.common.loading}</StatusIndicator>
                ) : (
                  <StatusIndicator type="error">{node.message}</StatusIndicator>
                ),
              announcementLabel: node.message ?? t.space.loadingAnnouncement,
            };
          }
          if (node.kind === 'more') {
            const moreError = moreErrors[node.parentPageId ?? ROOT];
            return {
              content: (
                <SpaceBetween size="xxs">
                  <Link
                    variant="primary"
                    onFollow={() => void loadMore(node.parentPageId, node.cursor)}
                  >
                    {t.space.loadMore}
                  </Link>
                  {moreError !== undefined && (
                    <StatusIndicator type="error">{moreError}</StatusIndicator>
                  )}
                </SpaceBetween>
              ),
              announcementLabel: t.space.loadMoreAnnouncement,
            };
          }
          if (node.kind === 'new') {
            return {
              icon: <Icon name={node.nodeKind === 'folder' ? 'folder' : 'file'} />,
              content: titleInput(
                t.space.titlePlaceholder(node.nodeKind),
                () => void create(node.parentPageId, node.nodeKind),
              ),
              announcementLabel: t.space.newNodeAnnouncement(node.nodeKind),
            };
          }

          const nodeKind = node.page.kind;
          const title = node.page.title || t.space.untitled;
          // The icon says which kind the row is, and it is the only thing that
          // does: the two kinds share one namespace and one sort order, so a
          // folder is not gathered above the pages beside it.
          const icon = <Icon name={nodeKind === 'folder' ? 'folder' : 'file'} />;
          if (renaming === node.page.pageId) {
            return {
              icon,
              content: titleInput(
                t.space.titlePlaceholder(nodeKind),
                () => void rename(node.page, node.parentPageId),
              ),
              announcementLabel: t.space.renameAnnouncement(title),
            };
          }

          const href = hrefNode(spaceId, node.page.pageId, nodeKind);

          // The move, as this row sees it. Only a folder can receive the drop,
          // and only one the dragged node may actually land in — a row that
          // cannot take the drop shows the refusal instead of a dead target.
          const isDragSource = move.drag?.page.pageId === node.page.pageId;
          const validTarget = move.canDrop({
            pageId: node.page.pageId,
            kind: nodeKind,
            chain: node.chain,
          });
          const rowClass = [
            'wiki-tree-row',
            isDragSource ? 'wiki-drag-src' : '',
            move.drag !== null && !isDragSource && overId === node.page.pageId
              ? validTarget
                ? 'wiki-drop-ok'
                : 'wiki-drop-ng'
              : '',
            move.movedId === node.page.pageId ? 'wiki-moved-flash' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const dragProps = editable
            ? {
                draggable: true,
                onDragStart: (e: DragEvent) => {
                  e.dataTransfer.effectAllowed = 'move';
                  // Some browsers refuse to start a drag that carries no data.
                  e.dataTransfer.setData('text/plain', node.page.pageId);
                  move.start({ page: node.page, parentPageId: node.parentPageId });
                },
                onDragEnd: () => {
                  clearSpring();
                  setOverId(null);
                  move.end();
                },
                onDragOver: (e: DragEvent) => {
                  if (move.drag === null || isDragSource) return;
                  if (validTarget) {
                    // preventDefault is what makes the row a drop target at
                    // all; withholding it on an invalid row is what shows the
                    // no-drop cursor.
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                  setOverId(node.page.pageId);
                },
                onDragEnter: (e: DragEvent) => {
                  if (!validTarget) return;
                  if (node.children === undefined || expanded.includes(node.page.pageId)) return;
                  // Entering from one of the row's own children is not an
                  // arrival — dragenter bubbles, and resetting the timer for
                  // every inner crossing would keep a restless pointer from
                  // ever unfolding the row.
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  clearSpring();
                  const folderId = node.page.pageId;
                  springTimer.current = window.setTimeout(() => {
                    setExpanded((prev) => (prev.includes(folderId) ? prev : [...prev, folderId]));
                  }, SPRING_MS);
                },
                onDragLeave: (e: DragEvent) => {
                  // Moving between the row's own children fires leave/enter
                  // pairs; only leaving the row itself puts the light out.
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  clearSpring();
                  setOverId((prev) => (prev === node.page.pageId ? null : prev));
                },
                onDrop: (e: DragEvent) => {
                  e.preventDefault();
                  clearSpring();
                  setOverId(null);
                  if (!validTarget) return;
                  const folderId = node.page.pageId;
                  void move.moveTo(folderId).then((moved) => {
                    // Unfold the folder that just took the node, so the drop
                    // is seen landing rather than vanishing behind a toggle.
                    if (moved) {
                      setExpanded((prev) =>
                        prev.includes(folderId) ? prev : [...prev, folderId],
                      );
                    }
                  });
                },
              }
            : {};
          return {
            icon,
            // One line, cut with an ellipsis, whatever the panel's width. A
            // title that wrapped would push the rows below it down and make the
            // tree harder to scan the narrower the panel gets, which is the
            // opposite of what narrowing it is for. `TruncatedText` puts the
            // full title in a tooltip on hover and on focus, so nothing that was
            // cut is out of reach — it is given `tooltipText` because the slot
            // holds a link.
            content: (
              <span className={rowClass} {...dragProps}>
                <TruncatedText tooltipText={title}>
                  <Box
                    variant="span"
                    fontWeight={node.page.pageId === currentPageId ? 'bold' : 'normal'}
                  >
                    <Link
                      href={href}
                      variant="secondary"
                      onFollow={(e) => {
                        e.preventDefault();
                        navigate(href);
                      }}
                    >
                      {title}
                    </Link>
                  </Box>
                </TruncatedText>
              </span>
            ),
            // Held in the DOM at all times and revealed by the row's hover or
            // focus (see `.wiki-tree-actions` in styles.css): laying them out
            // only on hover would shift the title as the pointer arrives, and
            // keeping them out of the DOM would put them out of reach of the
            // keyboard.
            actions: editable ? (
              <span className="wiki-tree-actions">
                <ButtonDropdown
                  variant="inline-icon"
                  iconSvg={HORIZONTAL_ELLIPSIS}
                  ariaLabel={t.space.rowActions(title)}
                  expandToViewport
                  items={[
                    { id: 'rename', text: t.common.rename },
                    { id: 'delete', text: t.common.delete },
                  ]}
                  onItemClick={({ detail }) => {
                    if (detail.id === 'rename') startRename(node.page);
                    if (detail.id === 'delete') {
                      setDeleting({
                        pageId: node.page.pageId,
                        parentPageId: node.parentPageId,
                        nodeKind,
                        title,
                        childPrompt: null,
                        busy: false,
                        error: null,
                      });
                    }
                  }}
                />
                {/* Only on a folder row, and offering both kinds. A page cannot
                    be a parent, so a plus on a page row would open an
                    input for a create the server refuses. */}
                {nodeKind === 'folder' && (
                  <ButtonDropdown
                    variant="inline-icon"
                    iconName="add-plus"
                    ariaLabel={t.space.addInside(title)}
                    expandToViewport
                    items={[
                      { id: 'page', text: t.space.createPage },
                      { id: 'folder', text: t.space.createFolder },
                    ]}
                    onItemClick={({ detail }) => {
                      onNewNode({
                        parentPageId: node.page.pageId,
                        kind: detail.id === 'folder' ? 'folder' : 'page',
                      });
                    }}
                  />
                )}
              </span>
            ) : undefined,
            announcementLabel: title,
          };
        }}
      />
    );

  return (
    <div
      className="wiki-page-tree"
      // The move's colours, taken from the live theme the way the shell's
      // header border is: the tokens resolve in light and dark alike.
      style={
        {
          '--wiki-drop-ok-bg': colorBackgroundItemSelected,
          '--wiki-drop-ng-bg': colorBackgroundStatusError,
          '--wiki-drop-border': colorBorderItemFocused,
          '--wiki-flash-bg': colorBackgroundStatusSuccess,
        } as CSSProperties
      }
    >
      {move.error !== null && (
        <Box padding={{ bottom: 'xs' }}>
          <StatusIndicator type="error">{move.error}</StatusIndicator>
        </Box>
      )}
      {tree}

      {deleting !== null && (
        <Modal
          visible
          header={
            deleting.childPrompt === null
              ? t.space.deleteHeader(deleting.nodeKind)
              : t.space.deleteChildHeader(deleting.nodeKind)
          }
          onDismiss={() => setDeleting(null)}
          footer={
            <Box float="right">
              <SpaceBetween size="xs" direction="horizontal">
                <Button disabled={deleting.busy} onClick={() => setDeleting(null)}>
                  {t.common.cancel}
                </Button>
                {deleting.childPrompt === null ? (
                  <Button
                    variant="primary"
                    loading={deleting.busy}
                    onClick={() => void runDelete('reject')}
                  >
                    {t.common.delete}
                  </Button>
                ) : (
                  <>
                    <Button disabled={deleting.busy} onClick={() => void runDelete('reparent')}>
                      {t.space.reparentAndDelete(deleting.nodeKind)}
                    </Button>
                    <Button
                      variant="primary"
                      loading={deleting.busy}
                      onClick={() => void runDelete('cascade')}
                    >
                      {t.space.cascadeDelete(deleting.nodeKind)}
                    </Button>
                  </>
                )}
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="s">
            <span>
              {deleting.childPrompt ?? t.space.deleteConfirm(deleting.title)}
            </span>
            {deleting.error !== null && <ErrorText>{deleting.error}</ErrorText>}
          </SpaceBetween>
        </Modal>
      )}
    </div>
  );
}

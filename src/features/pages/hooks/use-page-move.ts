/**
 * Drag-and-drop moves in the page tree: the state of the drag, the rules for
 * where it may land, and the call that performs the move.
 *
 * The hook lives one level above the tree because the drop targets do not all
 * sit inside it: a folder row is one, and the space-name row above the tree is
 * the other — it stands for the space root, which has no row of its own. The
 * shell calls this hook once, wires the header itself (`rootProps`), and hands
 * the rest to the tree.
 *
 * A drop decides only which parent the node joins. Siblings are shown
 * folders-first by name and that order is never stored, so there is no
 * insertion position to pick and no row-gap to indicate — the whole
 * interaction is "onto a folder", never "between two rows".
 *
 * Nothing here moves layout. Every signal a drag produces is a class on a row
 * that already exists, so the tree stands still while the pointer travels.
 */
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { api } from 'aws-blocks';
import { errMessage } from '@/utils/errors';
import { noteMovedNode } from '@/features/pages/api/page-cache';
import type { Page } from '@/types/api';

/** The node being dragged: the row's own record, and the parent it sits under. */
export type MoveDrag = { page: Page; parentPageId: string | null };

export type PageMove = ReturnType<typeof usePageMove>;

/** How long a moved row stays highlighted at its new place. */
const FLASH_MS = 1600;

export function usePageMove(spaceId: string) {
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  // The space-name row's own hover state, since that row is not a tree row:
  // 'ok' lights it as a target, 'ng' marks a drop that would do nothing.
  const [rootOver, setRootOver] = useState<'ok' | 'ng' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The row to flash at its destination. The flash is what says where the node
  // went: the name-ordered level decides the place, not the drop point.
  const [movedId, setMovedId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const start = (dragged: MoveDrag) => {
    // A previous move's error has been seen; starting over is what clears it.
    setError(null);
    setDrag(dragged);
  };

  const end = () => {
    setDrag(null);
    setRootOver(null);
  };

  /**
   * Whether the dragged node may land on this target: a folder row, or `null`
   * for the space root. `chain` is the target's own ancestor ids, which the
   * tree knows for every row it draws — a target inside the dragged subtree is
   * refused here, as the server would refuse it, so the row never lights up
   * for a drop that cannot succeed. A page row is refused because a page
   * cannot hold children, and the parent the node already sits under because
   * that drop would change nothing.
   */
  const canDrop = (target: { pageId: string; kind: string; chain: string[] } | null): boolean => {
    if (drag === null) return false;
    if (target === null) return drag.parentPageId !== null;
    if (target.kind !== 'folder') return false;
    if (target.pageId === drag.page.pageId) return false;
    if (target.pageId === drag.parentPageId) return false;
    if (target.chain.includes(drag.page.pageId)) return false;
    return true;
  };

  /**
   * Perform the move and tell the cache. `afterPageId` is not sent: the server
   * places the node last among its new siblings, and the position it answers
   * with matters only as the sort's tiebreak — the screen orders by name.
   *
   * Returns whether the move happened, so the caller can unfold the folder
   * that just received the node.
   */
  const moveTo = async (toParentId: string | null): Promise<boolean> => {
    if (drag === null) return false;
    const { page, parentPageId } = drag;
    try {
      const result = await api.movePage(page.pageId, { parentPageId: toParentId });
      // The row is inserted into its new level as the server now holds it:
      // with the parent it answered with, not the one the drag started from.
      noteMovedNode({
        spaceId,
        page: { ...page, position: result.position, parentPageId: result.parentPageId },
        fromParentId: parentPageId,
        toParentId,
      });
      setMovedId(page.pageId);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setMovedId(null), FLASH_MS);
      // The drag is over here, not at `dragend`: the drop just re-rendered the
      // source row out of the tree, and a `dragend` fired on a detached node
      // never reaches React's delegated listener — waiting for it would leave
      // the moved row painted as a drag source.
      end();
      return true;
    } catch (e) {
      // Depth over the cap, a concurrent delete, lost permission: the server's
      // word, shown above the tree. The tree itself has not changed.
      setError(errMessage(e));
      return false;
    }
  };

  /** Handlers for the space-name row, the drop target that means "to the root". */
  const rootProps = {
    onDragOver: (e: DragEvent) => {
      if (drag === null) return;
      if (canDrop(null)) {
        // preventDefault is what makes the element a drop target at all;
        // withholding it on an invalid row is what shows the no-drop cursor.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setRootOver('ok');
      } else {
        setRootOver('ng');
      }
    },
    onDragLeave: (e: DragEvent) => {
      // Moving between the row's own children fires leave/enter pairs; only
      // leaving the row itself puts the light out.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setRootOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setRootOver(null);
      if (canDrop(null)) void moveTo(null);
    },
  };

  return { drag, start, end, canDrop, moveTo, error, movedId, rootOver, rootProps };
}

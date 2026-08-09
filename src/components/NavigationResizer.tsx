import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { colorBorderItemFocused } from '@cloudscape-design/design-tokens';
import { useT } from '../i18n';

export const NAVIGATION_WIDTH_MIN = 200;
export const NAVIGATION_WIDTH_MAX = 560;
export const NAVIGATION_WIDTH_DEFAULT = 280;

const STORAGE_KEY = 'sl-wiki:navigation-width';

export function clampNavigationWidth(width: number): number {
  return Math.min(NAVIGATION_WIDTH_MAX, Math.max(NAVIGATION_WIDTH_MIN, Math.round(width)));
}

/** The width this browser was last left at, or the default. */
export function readStoredNavigationWidth(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampNavigationWidth(stored) : NAVIGATION_WIDTH_DEFAULT;
}

export function storeNavigationWidth(width: number): void {
  localStorage.setItem(STORAGE_KEY, String(width));
}

/**
 * The grip that sets the width of the navigation panel.
 *
 * `AppLayout` takes the width as a number and never offers to change it — only
 * its drawers are resizable — so the handle is ours: a thin strip pinned to the
 * panel's right edge, dragging which reports a new width to the shell.
 *
 * It is rendered into `document.body` rather than inside the panel. The panel
 * scrolls its own content, and a handle placed in that content would scroll
 * with it; the strip has to stay put down the whole edge. Fixed positioning
 * needs to know where the edge is, and it does: the panel starts at the left of
 * the viewport, below the top bar, and is exactly `width` wide.
 *
 * The keyboard reaches it too. It is a `separator` with a value, so arrow keys
 * move it in steps for anyone not using a pointer.
 */
export function NavigationResizer({
  width,
  onChange,
  onCommit,
}: {
  width: number;
  /** Called continuously while dragging. */
  onChange: (width: number) => void;
  /** Called when the gesture ends, which is when the width is worth keeping. */
  onCommit: (width: number) => void;
}) {
  const t = useT();
  const [top, setTop] = useState(0);
  const [dragging, setDragging] = useState(false);

  // The top bar is a sibling of the layout, not part of it, so its height is
  // where the panel — and therefore this strip — begins. It is measured rather
  // than assumed because the bar grows on narrow viewports.
  useEffect(() => {
    const bar = document.getElementById('top-navigation');
    if (bar === null) return;
    const measure = () => setTop(bar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const step = (delta: number) => {
    const next = clampNavigationWidth(width + delta);
    onChange(next);
    onCommit(next);
  };

  return createPortal(
    <div
      className={`wiki-nav-resizer${dragging ? ' wiki-nav-resizer-active' : ''}`}
      style={
        {
          left: `${width}px`,
          top: `${top}px`,
          '--wiki-resizer-color': colorBorderItemFocused,
        } as CSSProperties
      }
      role="separator"
      aria-orientation="vertical"
      aria-label={t.app.resizeNavigation}
      aria-valuenow={width}
      aria-valuemin={NAVIGATION_WIDTH_MIN}
      aria-valuemax={NAVIGATION_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        // Capture on the strip itself: the pointer will leave a 10px-wide
        // element immediately, and without capture the drag would end there.
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (dragging) onChange(clampNavigationWidth(e.clientX));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        onCommit(width);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          step(-16);
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          step(16);
        }
      }}
      onDoubleClick={() => {
        onChange(NAVIGATION_WIDTH_DEFAULT);
        onCommit(NAVIGATION_WIDTH_DEFAULT);
      }}
    />,
    document.body,
  );
}

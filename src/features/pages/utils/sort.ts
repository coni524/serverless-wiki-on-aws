import type { Page } from '@/types/api';

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

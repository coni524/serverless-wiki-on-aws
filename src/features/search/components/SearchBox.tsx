import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import { useT } from '@/lib/i18n';
import { isTypedKey } from '@/utils/ime';
import { hrefNode, hrefSearch, navigate, useRoute } from '@/lib/router';

/**
 * The search box in the top navigation. Searching from inside a space — or from
 * an already space-scoped result list — keeps that space as the scope;
 * SearchView offers the link out to a cross-space search.
 *
 * Typing opens a list of suggestions from `api.suggest`, which matches title
 * prefixes and the keyword index only — both answer out of the handler's
 * memory, which is what makes them affordable per keystroke. Picking one jumps
 * straight to that page; pressing Enter runs the full search, semantic half
 * included, and lands on the result list.
 */

/** How long the typing has to settle before a request goes out. */
const DEBOUNCE_MS = 200;

type Suggestion = Awaited<ReturnType<typeof api.suggest>>['items'][number];

const keyOf = (item: Suggestion) => `${item.spaceId}/${item.pageId}`;

export function SearchBox() {
  const t = useT();
  const route = useRoute();
  const spaceId =
    route.name === 'space' || route.name === 'page' || route.name === 'search'
      ? route.spaceId
      : null;
  const [q, setQ] = useState(route.name === 'search' ? route.query : '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);

  // When the route drives the query (the scope link re-navigates with the same
  // words), the box follows; typing elsewhere leaves the draft alone.
  useEffect(() => {
    if (route.name === 'search') setQ(route.query);
  }, [route]);

  // Every request carries the generation it was issued in, and an answer from
  // an older generation is dropped: keystrokes outrun round trips, and the
  // last one typed is the only one whose answer should be shown.
  const generation = useRef(0);
  useEffect(() => {
    const query = q.trim();
    generation.current += 1;
    const issued = generation.current;
    if (query === '') {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .suggest(query, spaceId === null ? undefined : { spaceId })
        .then((result) => {
          if (issued !== generation.current) return;
          setSuggestions(result.items);
          setLoading(false);
        })
        .catch(() => {
          // Suggestions are an accelerator, never the way to reach a page:
          // Enter still runs the real search. A failure closes the list.
          if (issued !== generation.current) return;
          setSuggestions([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, spaceId]);

  const search = () => {
    const query = q.trim();
    if (query !== '') navigate(hrefSearch(query, spaceId));
  };

  // Cloudscape fires `onSelect` and *then* `onKeyDown` for the Enter that picks
  // a suggestion — the keydown is passed on outside the "dropdown was open"
  // branch. Without this mark, the search that Enter would otherwise start
  // overwrites the page the selection just navigated to, and only for keyboard
  // users. The mark is dropped at the end of the task: the keydown arrives
  // within the same native event, and a mouse click leaves nothing behind.
  const selectionHandled = useRef(false);
  const markSelectionHandled = () => {
    selectionHandled.current = true;
    setTimeout(() => {
      selectionHandled.current = false;
    }, 0);
  };

  return (
    <Autosuggest
      value={q}
      placeholder={t.page.searchPlaceholder}
      ariaLabel={t.page.searchAriaLabel}
      // The server already decided what matches; re-filtering here on the
      // literal string would drop the hits that were found in a page's text.
      filteringType="manual"
      statusType={loading ? 'loading' : 'finished'}
      loadingText={t.page.suggestLoading}
      empty={t.page.suggestEmpty}
      enteredTextLabel={(value) => t.page.suggestUseQuery(value)}
      options={suggestions.map((item) => ({
        value: keyOf(item),
        label: item.title !== '' ? item.title : t.page.untitled,
        // The space is what tells two same-named pages apart, so it is shown
        // whenever the search is not already confined to one space.
        ...(spaceId === null && item.spaceName !== ''
          ? { description: item.spaceName }
          : {}),
      }))}
      onChange={(e) => setQ(e.detail.value)}
      onSelect={(e) => {
        markSelectionHandled();
        // `selectedOption` is absent exactly when the "search for what I typed"
        // entry was taken, which is what tells the two apart — the option's own
        // value is an id pair the typed text could in principle equal.
        const picked =
          e.detail.selectedOption === undefined
            ? undefined
            : suggestions.find((item) => keyOf(item) === e.detail.value);
        if (picked === undefined) {
          // Cloudscape has already put the typed text back in the box, so this
          // is the ordinary search.
          search();
          return;
        }
        // Cloudscape sets the box to the option's value, which is an id pair.
        // The words that were typed are what belongs in a search box, so they
        // go back in as the page opens.
        setQ(q);
        navigate(hrefNode(picked.spaceId, picked.pageId, picked.kind === 'folder' ? 'folder' : 'page'));
      }}
      onKeyDown={(e) => {
        // `isTypedKey` keeps the Enter that confirms a Japanese conversion from
        // searching for a half-typed query.
        if (!isTypedKey(e.detail)) return;
        if (e.detail.key !== 'Enter') return;
        // This Enter already picked a suggestion; searching now would undo the
        // navigation `onSelect` just made.
        if (selectionHandled.current) return;
        search();
      }}
    />
  );
}

import { useEffect, useState } from 'react';
import Input from '@cloudscape-design/components/input';
import { useT } from '../i18n';
import { isTypedKey } from '../lib';
import { hrefSearch, navigate, useRoute } from '../router';

/**
 * The search box in the top navigation. Searching from inside a space — or from
 * an already space-scoped result list — keeps that space as the scope;
 * SearchView offers the link out to a cross-space search.
 */
export function SearchBox() {
  const t = useT();
  const route = useRoute();
  const spaceId =
    route.name === 'space' || route.name === 'page' || route.name === 'search'
      ? route.spaceId
      : null;
  const [q, setQ] = useState(route.name === 'search' ? route.query : '');

  // When the route drives the query (the scope link re-navigates with the same
  // words), the box follows; typing elsewhere leaves the draft alone.
  useEffect(() => {
    if (route.name === 'search') setQ(route.query);
  }, [route]);

  return (
    <Input
      type="search"
      value={q}
      placeholder={t.page.searchPlaceholder}
      ariaLabel={t.page.searchAriaLabel}
      onChange={(e) => setQ(e.detail.value)}
      onKeyDown={(e) => {
        // `isTypedKey` keeps the Enter that confirms a Japanese conversion from
        // searching for a half-typed query.
        if (!isTypedKey(e.detail)) return;
        if (e.detail.key !== 'Enter') return;
        const query = q.trim();
        if (query !== '') navigate(hrefSearch(query, spaceId));
      }}
    />
  );
}

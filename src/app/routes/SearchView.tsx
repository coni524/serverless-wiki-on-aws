import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useT } from '@/lib/i18n';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import { searchQuery } from '@/features/search/api/search';
import { spaceQuery } from '@/features/spaces/api/space-cache';
import type { SearchItem } from '@/types/api';
import { hrefPage, hrefSearch, navigate } from '@/lib/router';

/**
 * Search results — semantic and keyword hits, fused by the backend into one
 * list. The backend collapses chunks to pages, filters them by permission,
 * and attaches live titles and snippets before returning, so this view only
 * renders what it is given. The one shaping it does: a snippet's `highlights`
 * ranges — where the keyword search matched — are rendered emboldened.
 */
export function SearchView({ query, spaceId }: { query: string; spaceId: string | null }) {
  const t = useT();
  const q = query.trim();
  const { data, error, isPending, isFetching, refetch } = useQuery(searchQuery(q, spaceId));

  // Result rows carry their space name; only the scope line above the list
  // needs a lookup, and only when the search is confined to one space — and
  // then it is the same entry the space screen reads, so a search run from
  // inside a space names it without asking again.
  const { data: scopeSpace } = useQuery({
    ...spaceQuery(spaceId ?? ''),
    enabled: spaceId !== null,
  });

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            spaceId !== null ? (
              <>
                {t.page.searchScope(scopeSpace?.name ?? spaceId)}{' '}
                <Link onFollow={() => navigate(hrefSearch(q, null))}>{t.page.searchAllSpaces}</Link>
              </>
            ) : undefined
          }
          actions={
            q !== '' ? (
              // The hash does not change on a same-query resubmit, so this is
              // the way to retry while waiting out the re-ingestion delay. The
              // results already found stay on screen while it runs.
              <Button iconName="refresh" loading={isFetching} onClick={() => void refetch()}>
                {t.page.searchAgain}
              </Button>
            ) : undefined
          }
        >
          {q === '' ? t.page.searchHeading : t.page.resultsHeading(q)}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {q === '' && <Box color="text-status-inactive">{t.page.searchPrompt}</Box>}
        {q !== '' && isPending && <Loading label={t.page.searching} />}
        {error !== null && <ErrorText>{t.page.searchFailed(errMessage(error))}</ErrorText>}

        {q !== '' && !isPending && error === null && data !== undefined && (
          <Cards
            items={data.items}
            trackBy={(item) => `${item.spaceId}/${item.pageId}`}
            cardDefinition={{
              header: (item) => <ResultLink item={item} />,
              sections: [
                {
                  id: 'space',
                  content: (item) =>
                    spaceId === null ? (
                      <Box color="text-body-secondary">
                        {item.spaceName !== '' ? item.spaceName : item.spaceId}
                      </Box>
                    ) : null,
                },
                {
                  id: 'snippet',
                  content: (item) =>
                    item.snippet !== '' ? (
                      <Box color="text-body-secondary">
                        <Snippet item={item} />
                      </Box>
                    ) : null,
                },
              ],
            }}
            empty={
              <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
                <SpaceBetween size="xs">
                  <span>{t.page.noResults}</span>
                  <span>{t.page.noResultsHint}</span>
                </SpaceBetween>
              </Box>
            }
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}

/** The snippet text with its matched ranges emboldened. */
function Snippet({ item }: { item: SearchItem }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of item.highlights) {
    if (start > cursor) parts.push(item.snippet.slice(cursor, start));
    parts.push(<strong key={start}>{item.snippet.slice(start, end)}</strong>);
    cursor = end;
  }
  parts.push(item.snippet.slice(cursor));
  return <>{parts}</>;
}

function ResultLink({ item }: { item: SearchItem }) {
  const t = useT();
  const href = hrefPage(item.spaceId, item.pageId);
  return (
    <Link
      href={href}
      fontSize="heading-m"
      onFollow={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {item.title !== '' ? item.title : t.page.untitled}
    </Link>
  );
}

import { api } from 'aws-blocks';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useT } from '../i18n';
import { ErrorText, Loading, useAsync, type SearchItem } from '../lib';
import { hrefPage, hrefSearch, navigate } from '../router';

/**
 * Semantic search results. The backend collapses chunks to pages,
 * filters them by permission, and attaches live titles before returning, so
 * this view only renders what it is given.
 */
export function SearchView({ query, spaceId }: { query: string; spaceId: string | null }) {
  const t = useT();
  const q = query.trim();
  const { data, error, loading, reload } = useAsync(
    () =>
      q === ''
        ? Promise.resolve({ items: [] as SearchItem[] })
        : api.search(q, spaceId === null ? undefined : { spaceId }),
    [q, spaceId],
  );

  // Result rows carry their space name; only the scope line above the list
  // needs a lookup, and only when the search is confined to one space.
  const { data: scopeSpace } = useAsync(
    () => (spaceId === null ? Promise.resolve(null) : api.getSpace(spaceId)),
    [spaceId],
  );

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
              // the way to retry while waiting out the re-ingestion delay.
              <Button iconName="refresh" onClick={reload}>
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
        {q !== '' && loading && <Loading label={t.page.searching} />}
        {error !== null && <ErrorText>{t.page.searchFailed(error)}</ErrorText>}

        {q !== '' && !loading && error === null && data !== null && (
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
                    item.snippet !== '' ? <Box color="text-body-secondary">{item.snippet}</Box> : null,
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

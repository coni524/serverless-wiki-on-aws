/**
 * Search results, held per query.
 *
 * There is nothing to write here, so no write applies anything to this entry.
 * What the cache buys is the way back: a reader who opens a result and returns
 * sees the list they left while it is checked against the server, instead of
 * the spinner they used to get.
 *
 * Results are not persisted to disk — the backend filters every hit by
 * permission before returning it, and a restored list would carry yesterday's
 * answer to that question.
 */
import { api } from 'aws-blocks';
import { type QueryKey } from '@tanstack/react-query';

export const searchKey = (query: string, spaceId: string | null): QueryKey => [
  'search',
  query,
  spaceId,
];

/**
 * The query behind one search. Disabled for an empty term: the screen shows a
 * prompt then, and asking the backend to rank nothing costs a Bedrock call.
 */
export function searchQuery(query: string, spaceId: string | null) {
  return {
    queryKey: searchKey(query, spaceId),
    queryFn: () => api.search(query, spaceId === null ? undefined : { spaceId }),
    enabled: query !== '',
  };
}

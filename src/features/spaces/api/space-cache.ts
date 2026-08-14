/**
 * The spaces a reader can reach, and one space's own record.
 *
 * Two questions, two entries, and both are shared rather than fetched per
 * screen: `mySpaces` answers the space list and the navigation panel's
 * switcher, and `getSpace` answers the space screen and the scope line above a
 * search confined to one space. A listing fetched by either screen is on
 * screen in both.
 *
 * Both are permission answers — the server filters them by what the caller
 * holds — so neither is persisted to disk; `app/provider.tsx` dehydrates page
 * bodies and nothing else.
 */
import { api } from 'aws-blocks';
import { type QueryKey } from '@tanstack/react-query';
import { queryClient } from '@/lib/react-query';

/** Every space the signed-in reader may read, with the permission held on each. */
export const mySpacesKey: QueryKey = ['spaces'];

/** One space's name, description, and the reader's permission on it. */
export const spaceKey = (spaceId: string): QueryKey => ['space', spaceId];

export function mySpacesQuery() {
  return { queryKey: mySpacesKey, queryFn: () => api.mySpaces() };
}

export function spaceQuery(spaceId: string) {
  return { queryKey: spaceKey(spaceId), queryFn: () => api.getSpace(spaceId) };
}

/**
 * A space was created.
 *
 * The create call answers with an id and nothing else — not the place the new
 * space takes in the list, which `mySpaces` sorts by name — so the listing is
 * asked again rather than guessed at. The cards already drawn stay where they
 * are while that runs.
 */
export function noteCreatedSpace(): void {
  void queryClient.invalidateQueries({ queryKey: mySpacesKey });
}

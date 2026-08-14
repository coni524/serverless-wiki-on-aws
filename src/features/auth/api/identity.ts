/**
 * Who is signed in, as the Wiki knows them.
 *
 * The auth block's `username` is not this: with sign-in by email address the
 * pool generates it, so on the real pool it is the Cognito `sub`. The address
 * the reader typed, and whether they are a global administrator, come from
 * `me()` — which is a permission answer, so it is read from the server and
 * never persisted to disk (see the dehydrate rule in `app/provider.tsx`).
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { api } from 'aws-blocks';

export const meKey: QueryKey = ['me'];

/**
 * The signed-in identity, or nothing while signed out.
 *
 * `enabled` rather than a branch inside the fetch: a signed-out shell has no
 * identity to hold, and asking for one would only be refused.
 */
export function useMe(signedIn: boolean) {
  return useQuery({
    queryKey: meKey,
    queryFn: () => api.me(),
    enabled: signedIn,
  });
}

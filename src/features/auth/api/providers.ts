/**
 * Which ways in this deployment offers.
 *
 * Asked at runtime rather than read from a build-time constant, so that turning
 * federation on is a deploy of the backend and not a rebuild of this bundle.
 * The answer is the same for everyone and changes only when the deployment
 * does, so it is fetched once and kept.
 *
 * This is the one query that runs before anybody is signed in — the sign-in
 * screen is what asks it.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { api } from 'aws-blocks';

export const authProvidersKey: QueryKey = ['authProviders'];

export function useAuthProviders() {
  return useQuery({
    queryKey: authProvidersKey,
    queryFn: () => api.authProviders(),
    // Nothing a reader does changes it, and a failed fetch must not leave the
    // password form unreachable behind a spinner, so a miss simply means no
    // federated button.
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Where the browser goes to sign in with `provider`.
 *
 * A full navigation to the backend's own route, not a call: the flow is a
 * redirect to the identity provider and back, so the page has to leave. The
 * path is relative because the API answers on the origin this page was served
 * from — the dev server proxies it, and CloudFront forwards it.
 */
export function signInUrl(provider: string): string {
  return `/aws-blocks/auth/signin/${encodeURIComponent(provider)}`;
}

/** Where the browser goes to end a federated session. */
export const FEDERATED_SIGN_OUT_URL = '/aws-blocks/auth/signout';

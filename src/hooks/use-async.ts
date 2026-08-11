import { useCallback, useEffect, useRef, useState } from 'react';
import { errMessage } from '@/utils/errors';

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetch; useful after a mutation. */
  reload: () => void;
}

/**
 * Run an async fetch and track its state, cancelling a result that lands after
 * the inputs changed or the component unmounted. `reload()` forces a re-fetch.
 *
 * Being replaced by TanStack Query screen by screen: new data fetching goes
 * through `useQuery`, and a screen this hook still serves moves over when it
 * is next touched.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((result) => {
        if (!live) return;
        setData(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(errMessage(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

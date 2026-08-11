import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { LocaleProvider } from '@/lib/i18n';
import { PERSIST_MAX_AGE_MS, persister, queryClient } from '@/lib/react-query';

/**
 * Everything the component tree runs under: the query client with its
 * IndexedDB persistence, and the locale.
 *
 * `PersistQueryClientProvider` restores the persisted cache before letting
 * queries fetch, so a reload starts from the bodies the last session held and
 * revalidates them instead of re-downloading them.
 */
export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        // A new build starts from an empty persisted cache. What this guards
        // against is not staleness (the stamps handle that) but shape drift: a
        // response field added in this build meeting an entry persisted by the
        // previous one.
        buster: __BUILD_ID__,
        dehydrateOptions: {
          // Page bodies only. Tree levels and listings must not be restored:
          // the freshness stamps that justify showing a held body without
          // waiting have to come from a listing fetched by *this* session — a
          // restored body is drawn only once a fresh, permission-filtered
          // listing vouches for it.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' && query.queryKey[0] === 'page',
        },
      }}
    >
      <LocaleProvider>{children}</LocaleProvider>
    </PersistQueryClientProvider>
  );
}

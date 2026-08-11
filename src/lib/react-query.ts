import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { del, get, set } from 'idb-keyval';

/**
 * The one QueryClient, held here rather than created inside the provider so
 * that non-component code (the page cache in `features/pages/api`) can reach
 * the same cache without importing from the app layer.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Failures surface immediately, as they did before the migration: every
      // screen renders the error it got, and the user retries by acting again.
      retry: false,
      // Focus is not a freshness signal this app uses. Page bodies revalidate
      // on open (a stamp check the server answers cheaply), and refetching the
      // whole screen on tab switches would be new behaviour, not a migration.
      refetchOnWindowFocus: false,
      staleTime: 0,
    },
  },
});

/**
 * How long a persisted page body is worth restoring. Also the `gcTime` of the
 * page queries: entries the client garbage-collects earlier than the persister
 * would restore them are entries the restore brings back from the dead.
 */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STORAGE_KEY = 'sl-wiki-query-cache';

/**
 * IndexedDB, through idb-keyval's promise wrapper. `localStorage` is ruled out
 * by size (bodies are allowed 1 MiB each); IndexedDB has no such ceiling, and
 * the schema and async plumbing that once argued against it live in these two
 * packages, not here.
 */
export const persister = createAsyncStoragePersister({
  key: STORAGE_KEY,
  storage: {
    getItem: async (key) => ((await get<string>(key)) ?? null),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
});

/**
 * Drop the persisted copy of the query cache. Called when the signed-in
 * identity changes (and on sign-out, which is one case of it): clearing the
 * in-memory client empties what the persister will write next, but the copy
 * already on disk outlives the tab and must be removed by hand.
 */
export const clearPersistedCache = (): Promise<void> => del(STORAGE_KEY);

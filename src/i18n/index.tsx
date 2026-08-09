/**
 * The language the screen is drawn in.
 *
 * The choice is the reader's and the browser's to remember, the same way the
 * navigation panel's width is (`components/NavigationResizer.tsx`): read once
 * from storage, written back when it changes, and validated on the way out so a
 * hand-edited value falls back rather than reaching the dictionary.
 *
 * It is deliberately not sent to the server. The API's refusals are written in
 * English for every caller — the screen, the assistant's tools, the MCP server
 * and the sync API alike — so there is no per-request language to negotiate.
 * A refusal that has to be worded for the reader carries a structured error
 * name instead, and the screen words it (`PAGE_HAS_CHILDREN_ERROR` in `lib.tsx`
 * is the one that does). The assistant is the exception, and it is told the
 * language per turn rather than per session; see `sendAssistantMessage`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import I18nProvider, {
  importMessages,
  type I18nProviderProps,
} from '@cloudscape-design/components/i18n';
import { messages, type Messages } from './dict';

export type { Messages };

export type Locale = 'ja' | 'en';

/** In the order the switcher offers them, each named in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };
export const LOCALES = Object.keys(LOCALE_NAMES) as Locale[];

const STORAGE_KEY = 'sl-wiki:locale';
const FALLBACK: Locale = 'ja';

function isLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'en';
}

/**
 * The language this browser was last left at, or the closest one it asks for.
 *
 * `navigator.languages` is in the reader's own order of preference, so the
 * first entry that names a language we have is the right one — a reader whose
 * list is `['fr', 'en']` gets English rather than the fallback.
 */
export function readStoredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return FALLBACK;
}

export function storeLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale);
}

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Messages;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Holds the language and hands Cloudscape its own dictionary for it.
 *
 * Cloudscape's built-in wording — a table's sort labels, a drawer's close
 * button, the tree's expand and collapse labels — comes from its `I18nProvider`
 * rather than from ours, so both live here and change together. Its messages
 * are loaded on demand so only the chosen language is fetched; until the first
 * load lands the components use their own English defaults, which shows for a
 * frame and only in labels that are mostly read by screen readers.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setStored] = useState<Locale>(readStoredLocale);
  const [cloudscape, setCloudscape] = useState<ReadonlyArray<I18nProviderProps.Messages>>([]);

  // The document's language is what a screen reader picks a voice from, and
  // what the browser offers to translate against. `index.html` ships one; this
  // replaces it with the reader's own.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let live = true;
    void importMessages(locale).then((loaded) => {
      if (live) setCloudscape(loaded);
    });
    return () => {
      live = false;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setStored(next);
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, t: messages[locale] }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <I18nProvider locale={locale} messages={cloudscape}>
        {children}
      </I18nProvider>
    </LocaleContext.Provider>
  );
}

function useLocaleContext(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error('useT must be used inside LocaleProvider');
  return value;
}

/** The dictionary for the current language. What every screen reads. */
export function useT(): Messages {
  return useLocaleContext().t;
}

/** The current language and the way to change it. Only the switcher needs both. */
export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void } {
  const { locale, setLocale } = useLocaleContext();
  return { locale, setLocale };
}

/**
 * A stored timestamp as the reader's language writes it.
 *
 * Dates follow the language the reader chose rather than the browser's own, so
 * a reader who switched to English does not get one screen of English wording
 * around a Japanese date. Sibling order does not follow it — see the collator
 * in `lib.tsx`, which stays on the browser's locale on purpose.
 */
export function useDateTimeFormat(): (iso: string) => string {
  const { locale } = useLocaleContext();
  return useCallback((iso: string) => new Date(iso).toLocaleString(locale), [locale]);
}

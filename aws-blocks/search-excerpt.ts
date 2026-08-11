/**
 * Excerpts for keyword search hits — the text around the matched terms, with
 * the matched ranges reported so the UI can embolden them.
 *
 * The index keeps only term frequencies, never positions, so the excerpt is
 * built here instead: the caller reads the hit page's corpus document and
 * hands it to `excerptOf` together with the query. Everything in
 * this module is pure string work, which is what makes it unit-testable.
 *
 * Matching repeats the searcher's normalization — NFKC, lowercased — but keeps
 * each query run whole as a phrase instead of cutting it into bigrams: the
 * excerpt should embolden "東京タワー", not four overlapping fragments of it.
 * The normalization is done per composition group with a map back into the
 * original string, so the emphasized ranges land on the text as the author
 * wrote it, full-width characters and all.
 */

/** How many normalized characters the excerpt window spans. */
const WINDOW = 200;
/** How many of them come before the first hit, as leading context. */
const LEAD = 60;
/** Cap on occurrences collected per phrase; beyond this adds nothing visible. */
const MAX_OCCURRENCES = 50;

export type Excerpt = {
  /** Single-line plain text, whitespace collapsed, ellipses at cut edges. */
  snippet: string;
  /** `[start, end)` ranges in `snippet` that matched the query. */
  highlights: [number, number][];
};

/**
 * The literal phrases a query asks for: its runs of word characters, whole.
 *
 * The same run boundaries as the tokenizer (ASCII alphanumerics and other
 * letters/digits split at their meeting point), so what the searcher treated
 * as one unit is what gets emphasized as one unit. That includes the
 * tokenizer's blind spot: a single non-ASCII character yields no bigram and
 * never participated in the match, so it must not be emphasized either — and
 * being first in the text, it would steal the excerpt window from the phrase
 * that actually hit. A single ASCII character is a real term and stays.
 */
export function queryPhrases(query: string): string[] {
  const phrases: string[] = [];
  let run: string[] = [];
  let runClass: 'ascii' | 'word' | null = null;
  const flush = () => {
    if (run.length > 0 && (runClass === 'ascii' || run.length >= 2)) {
      phrases.push(run.join(''));
    }
    run = [];
    runClass = null;
  };
  for (const ch of query.normalize('NFKC').toLowerCase()) {
    const cls = /[a-z0-9]/.test(ch) ? 'ascii' : /[\p{L}\p{N}\p{M}]/u.test(ch) ? 'word' : null;
    if (cls !== runClass) flush();
    if (cls === null) continue;
    runClass = cls;
    run.push(ch);
  }
  flush();
  return [...new Set(phrases)];
}

/**
 * The text normalized the way the query is, plus a map back to the original.
 *
 * Normalizing character by character would miss compositions that only happen
 * across code points (half-width ｶ + ﾞ becoming one ガ), so the walk groups
 * each base character with the combining and sound marks that follow it and
 * normalizes the group whole. `map[i]` is the UTF-16 offset in `text` of the
 * group that produced `norm[i]`; a final entry holds `text.length` so any
 * `[start, end)` range in `norm` maps to a `[map[start], map[end])` slice.
 */
function normalizedWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  const marks = /[\p{M}ﾞﾟ]/u;
  let offset = 0;
  let group = '';
  let groupStart = 0;
  const flush = () => {
    if (group === '') return;
    for (const produced of group.normalize('NFKC').toLowerCase()) {
      norm += produced;
      map.push(groupStart);
    }
    group = '';
  };
  for (const ch of text) {
    if (group !== '' && marks.test(ch)) {
      group += ch;
    } else {
      flush();
      groupStart = offset;
      group = ch;
    }
    offset += ch.length;
  }
  flush();
  map.push(text.length);
  return { norm, map };
}

/** Merge overlapping or touching ranges, ascending. */
function merged(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** Collapse whitespace runs to single spaces, as the one-line list demands. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

/**
 * Build the excerpt of `text` around the first place `query` matches.
 *
 * No phrase found — the bigram AND can pass on terms scattered through the
 * page — degrades to the head of the text with no highlights, so the caller
 * can tell a real excerpt (`highlights` non-empty) from the fallback.
 */
export function excerptOf(text: string, query: string): Excerpt {
  const { norm, map } = normalizedWithMap(text);
  const phrases = queryPhrases(query);

  const found: [number, number][] = [];
  for (const phrase of phrases) {
    let from = 0;
    for (let seen = 0; seen < MAX_OCCURRENCES; seen += 1) {
      const at = norm.indexOf(phrase, from);
      if (at === -1) break;
      found.push([at, at + phrase.length]);
      from = at + phrase.length;
    }
  }
  const ranges = merged(found);

  const first = ranges[0];
  const windowStart = first === undefined ? 0 : Math.max(0, first[0] - LEAD);
  const windowEnd = Math.min(norm.length, windowStart + WINDOW);

  // Alternate plain and matched segments across the window, in original text.
  const segments: { text: string; hit: boolean }[] = [];
  let cursor = windowStart;
  for (const [start, end] of ranges) {
    if (end <= windowStart) continue;
    if (start >= windowEnd) break;
    const clippedStart = Math.max(start, windowStart);
    const clippedEnd = Math.min(end, windowEnd);
    if (clippedStart > cursor) {
      segments.push({ text: text.slice(map[cursor]!, map[clippedStart]!), hit: false });
    }
    segments.push({ text: text.slice(map[clippedStart]!, map[clippedEnd]!), hit: true });
    cursor = clippedEnd;
  }
  if (cursor < windowEnd) {
    segments.push({ text: text.slice(map[cursor]!, map[windowEnd]!), hit: false });
  }

  // Flatten each segment on its own; boundaries are exact, so offsets survive.
  const flattened = segments
    .map((segment) => ({ text: flat(segment.text), hit: segment.hit }))
    .filter((segment) => segment.text !== '');
  if (flattened.length > 0 && !flattened[0]!.hit) {
    flattened[0]!.text = flattened[0]!.text.trimStart();
  }
  const last = flattened.at(-1);
  if (last !== undefined && !last.hit) last.text = last.text.trimEnd();

  let snippet = windowStart > 0 ? '…' : '';
  const highlights: [number, number][] = [];
  for (const segment of flattened) {
    if (segment.hit) highlights.push([snippet.length, snippet.length + segment.text.length]);
    snippet += segment.text;
  }
  if (windowEnd < norm.length) snippet += '…';

  return { snippet, highlights };
}

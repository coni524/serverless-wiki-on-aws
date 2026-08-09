/**
 * A line diff, used to show a pending AI edit before it is written.
 *
 * Small on purpose. The only text this ever compares is one wiki page body
 * against the body the assistant proposes for it, and both are already in memory
 * because the panel fetched one and was handed the other. That rules out the
 * usual reasons to pull in a diff library: there is no patch format to parse and
 * no repository history to walk.
 *
 * Two levels, because one is not enough to review an edit. The line level says
 * which lines went and which came. Within a line that was replaced, the
 * character level says *where* — without it, a sentence whose ending changed is
 * drawn as a whole line removed and a whole line added, and the reader has to
 * find the difference by eye. That is the state this started in, and finding a
 * changed sentence ending in a paragraph that way is not review.
 */

/** A stretch of one line, marked as part of what changed or as context. */
export type DiffSegment = { text: string; changed: boolean };

/**
 * One line of the comparison, tagged with what happened to it.
 *
 * `segments` is present only on a line that was replaced rather than purely
 * added or removed, and only when the two versions still resemble each other.
 * When it is absent the whole line is the change, and the renderer says so by
 * drawing the line without any inner emphasis.
 */
export type DiffLine = {
  kind: 'same' | 'add' | 'remove';
  text: string;
  segments?: DiffSegment[];
};

/**
 * How many lines each side may have before the comparison is abandoned.
 *
 * The table below is `before.length * after.length` cells, so the cost is the
 * product, not the sum. A wiki page that reaches this size is far past the point
 * where a line diff would be readable anyway, so the caller is told to fall back
 * to showing the whole body rather than left waiting.
 */
const MAX_LINES = 800;

/** True when `diffLines` would refuse the comparison. */
export function tooLargeToDiff(before: string, after: string): boolean {
  return splitLines(before).length > MAX_LINES || splitLines(after).length > MAX_LINES;
}

/**
 * The lines of `before` and `after`, in order, each marked kept, added, or
 * removed.
 *
 * A longest-common-subsequence table decides which lines are the same ones: it
 * is what keeps an inserted paragraph from re-marking every line after it as
 * changed, which is the whole reason to diff rather than print both versions.
 *
 * Throws when either side is longer than `MAX_LINES`; check `tooLargeToDiff`
 * first.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    throw new Error('diffLines: input too large');
  }

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // Removals before additions at the same position, so a replaced line reads
      // as "this went, that came" rather than the other way round.
      out.push({ kind: 'remove', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'remove', text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j]! });
    j += 1;
  }
  markReplacements(out);
  return out;
}

// ─── Within a replaced line ──────────────────────────────────────────────────

/**
 * How much of the longer line must survive for the two to count as versions of
 * each other rather than unrelated lines that happen to sit together.
 *
 * Below this, marking the few characters they share picks out coincidences — a
 * shared particle, a shared bracket — and reads as noise. Those lines are left
 * without segments and drawn as a plain removal and a plain addition.
 */
const MIN_RESEMBLANCE = 0.3;

/**
 * The largest character table the inner comparison will build.
 *
 * Same product cost as the line table above, on the middles of two lines after
 * their common ends have been trimmed. A pair past this is marked as changed
 * end to end, which is what the display did for every pair before.
 */
const MAX_INLINE_CELLS = 40_000;

/**
 * Pair each removed line with the added line that replaced it, and mark the
 * characters that differ.
 *
 * A replacement appears in the line diff as a run of removals followed
 * immediately by a run of additions, so the pairing is positional: the first
 * removal goes with the first addition, the second with the second. Leftovers on
 * either side are a genuine deletion or insertion and keep no segments.
 */
function markReplacements(lines: DiffLine[]): void {
  let at = 0;
  while (at < lines.length) {
    if (lines[at]!.kind !== 'remove') {
      at += 1;
      continue;
    }
    let addsStart = at;
    while (addsStart < lines.length && lines[addsStart]!.kind === 'remove') addsStart += 1;
    let addsEnd = addsStart;
    while (addsEnd < lines.length && lines[addsEnd]!.kind === 'add') addsEnd += 1;

    const pairs = Math.min(addsStart - at, addsEnd - addsStart);
    for (let k = 0; k < pairs; k += 1) {
      const removed = lines[at + k]!;
      const added = lines[addsStart + k]!;
      const marked = markPair(removed.text, added.text);
      if (marked === null) continue;
      removed.segments = marked.before;
      added.segments = marked.after;
    }
    at = addsEnd > at ? addsEnd : at + 1;
  }
}

/**
 * The two versions of one line, each split into what changed and what did not.
 *
 * Null when the pair does not resemble one another closely enough to be worth
 * marking, or when either side is empty — an empty line has nothing to point at.
 *
 * The common start and end are taken off first. That is the cheap part of the
 * answer and usually most of the line, and it keeps the table that follows to
 * the stretch that actually differs.
 */
function markPair(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } | null {
  if (before === '' || after === '') return null;
  // By code point, so a character built from a surrogate pair is never cut in
  // half and rendered as two broken halves.
  const a = [...before];
  const b = [...after];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  // How much the two share, counting only the trimmed ends. Deliberately a
  // lower bound — an inner comparison could find more — because it is settled
  // before deciding whether the pair is worth comparing at all.
  const shared = head + tail;
  if (shared / Math.max(a.length, b.length) < MIN_RESEMBLANCE) return null;

  const inner =
    midA.length * midB.length <= MAX_INLINE_CELLS
      ? innerRuns(midA, midB)
      : { before: wholly(midA), after: wholly(midB) };

  const prefix = a.slice(0, head).join('');
  const suffix = a.slice(a.length - tail).join('');
  return {
    before: assemble(prefix, inner.before, suffix),
    after: assemble(prefix, inner.after, suffix),
  };
}

/** The middles compared character by character, as runs of kept and changed. */
function innerRuns(a: string[], b: string[]): { before: DiffSegment[]; after: DiffSegment[] } {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const before: DiffSegment[] = [];
  const after: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(before, a[i]!, false);
      push(after, b[j]!, false);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push(before, a[i]!, true);
      i += 1;
    } else {
      push(after, b[j]!, true);
      j += 1;
    }
  }
  while (i < a.length) {
    push(before, a[i]!, true);
    i += 1;
  }
  while (j < b.length) {
    push(after, b[j]!, true);
    j += 1;
  }
  return { before, after };
}

/** Append one character, extending the run in progress when it matches. */
function push(into: DiffSegment[], text: string, changed: boolean): void {
  const last = into.at(-1);
  if (last !== undefined && last.changed === changed) last.text += text;
  else into.push({ text, changed });
}

/** A middle too large to compare, marked as changed end to end. */
function wholly(chars: string[]): DiffSegment[] {
  return chars.length === 0 ? [] : [{ text: chars.join(''), changed: true }];
}

/** The trimmed ends put back around the compared middle. */
function assemble(prefix: string, middle: DiffSegment[], suffix: string): DiffSegment[] {
  const out: DiffSegment[] = [];
  if (prefix !== '') out.push({ text: prefix, changed: false });
  for (const segment of middle) push(out, segment.text, segment.changed);
  if (suffix !== '') push(out, suffix, false);
  return out;
}

/** How many lines the diff adds and removes, for a one-line summary. */
export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    if (line.kind === 'remove') removed += 1;
  }
  return { added, removed };
}

/**
 * Split into lines for comparison.
 *
 * `\r\n` is normalised first: a body that arrives with Windows line endings
 * would otherwise differ from the same body without them on every single line,
 * turning a one-word edit into a whole-page rewrite on screen.
 */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

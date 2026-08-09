// A deliberately minimal, XSS-safe Markdown renderer with no dependencies.
//
// Everything is HTML-escaped first; only tags this file emits are ever injected,
// and link targets are scheme-checked, so the escaped input cannot introduce
// markup or a `javascript:` URL. The trade is coverage: no tables, no GFM
// task lists, no nested lists. Images are covered, but only the page's own
// attachments — see `image` below. When the Wiki needs the rest, replace THIS
// module with `react-markdown` + `remark-gfm` — every caller reaches it through
// `<Markdown>` in `components/Markdown.tsx`, so the swap stays behind that.
//
// Nothing here touches React or the DOM, which is what lets the test suite pin
// down the escaping rules directly (`test/e2e.test.ts`).

/**
 * The two characters that fence a placeholder while inline rules run.
 *
 * Unicode's private use area, which no real text carries a meaning for, and
 * `escapeHtml` takes both out of the input regardless — so a body cannot write
 * one itself and have it read back as a placeholder.
 */
const HOLD_OPEN = '\uE000';
const HOLD_CLOSE = '\uE001';

function escapeHtml(text: string): string {
  return text
    .replace(/[\uE000\uE001]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Defence in depth: `'` too, so a future single-quoted attribute can't be
    // broken out of even though every attribute this file emits is "-quoted.
    .replace(/'/g, '&#39;');
}

/**
 * Return a link target only if it is provably safe, otherwise null.
 *
 * Deny by default: a scheme is allowed only when it is http(s) or mailto; every
 * other scheme (`javascript:`, `data:`, …) is rejected, and so is a
 * protocol-relative `//host`. Control characters are stripped up front —
 * browsers remove a leading control char before resolving the scheme, so
 * `javascript:` would otherwise masquerade as a scheme-less relative path
 * and slip through.
 */
function safeUrl(url: string): string | null {
  // `\p{Cc}` = the Unicode Control category (U+0000–U+001F, U+007F–U+009F).
  const cleaned = url.replace(/\p{Cc}/gu, '').trim();
  if (cleaned === '') return null;
  if (cleaned.startsWith('//')) return null; // protocol-relative → external
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    return name === 'http' || name === 'https' || name === 'mailto' ? cleaned : null;
  }
  return cleaned; // no scheme → a relative link (#, /path, ./x, ../x, plain)
}

/**
 * The scheme a page body uses to point at one of its own attachments:
 * `![alt](attachment:<id>)`.
 *
 * A body cannot hold the URL itself. A presigned URL expires within the minute,
 * and an unsigned one would mean a publicly readable object, which the private
 * bucket rules out. So the body holds the id, and the reader signs it at render time —
 * see `createAttachmentDownloadUrls` in `aws-blocks/index.ts`.
 */
const ATTACHMENT_SCHEME = 'attachment:';

/** Mirrors `cleanAttachmentId` on the server, which refuses anything else. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * How many distinct images one body asks to have signed.
 *
 * Matches `MAX_SIGNED_ATTACHMENTS` in `aws-blocks/attachments.ts`, which refuses
 * a longer list. Capping here rather than letting the request be refused keeps a
 * body with an absurd number of images renderable: the ones past the cap fall
 * back to their alt text instead of taking the whole page down.
 */
export const MAX_IMAGE_REFS = 200;

/**
 * The image markup: `![alt](url)`, with an alt that may be empty.
 *
 * Both classes exclude the character that opens them — `[` in the alt, `(` in
 * the URL — and that exclusion is what keeps the match linear. With `[^\]]*`,
 * a body of a million `[` cost one full scan of the line per `[` in it, because
 * the class ran to the end of the line and backtracked a character at a time
 * looking for a `]` that was never there. A body is up to 1 MiB of text anyone
 * with `write` can store, so that is a page that freezes every reader's tab.
 * Excluding the opener makes the class stop at the next one instead, which
 * bounds each attempt by the distance to it. `\n` is excluded for the same
 * reason and one more: `collectAttachmentRefs` runs this over the whole body
 * rather than a line, and an alt has no business spanning lines.
 */
const IMAGE = /!\[([^[\]\n]*)\]\(([^()\s]+)\)/g;

/** The resolved URL for each attachment id, or null while they are being signed. */
export type ImageUrls = Record<string, string> | null;

/**
 * Every attachment this body shows as an image, deduplicated and capped.
 *
 * Ids that could not be ours are dropped here rather than sent, because the
 * signing API refuses a malformed id for the whole request — one typo in a body
 * would otherwise cost that page every image it has.
 */
export function collectAttachmentRefs(source: string): string[] {
  const ids = new Set<string>();
  for (const [, , url] of source.matchAll(IMAGE)) {
    if (!url.startsWith(ATTACHMENT_SCHEME)) continue;
    const id = url.slice(ATTACHMENT_SCHEME.length);
    if (!ATTACHMENT_ID.test(id)) continue;
    ids.add(id);
    if (ids.size === MAX_IMAGE_REFS) break;
  }
  return [...ids];
}

/**
 * One `![alt](url)` as HTML, or null to leave the markup alone.
 *
 * Only an attachment of this page becomes an `<img>`. Every other target — an
 * external URL above all — is left to the link rule below and renders as a
 * link, not an embed. Rendering a remote image would have the reader's browser
 * fetch it on open, telling that host who read the page and when, and no page
 * needs that to show a picture it owns.
 */
function image(alt: string, url: string, images: ImageUrls, unavailable: string): string | null {
  if (!url.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = url.slice(ATTACHMENT_SCHEME.length);
  // The same check `collectAttachmentRefs` applies before asking for a
  // signature. Without it, `attachment:toString` reads a function off the
  // prototype of the lookup, and the render throws rather than the body simply
  // showing a missing image — one line in one page would blank the whole app.
  if (!ATTACHMENT_ID.test(id)) return alt || unavailable;
  // Not yet signed: render nothing, so the alt text does not flash into view and
  // out again as the URLs land.
  if (images === null) return '';
  const src = Object.hasOwn(images, id) ? images[id] : undefined;
  if (src === undefined) return alt || unavailable;
  // No `loading="lazy"`. A deferred image is fetched whenever it scrolls into
  // view, and by then the URL signed at render time may have expired — the
  // download window is 60 seconds. Fetching every image up front
  // keeps the request inside the window it was signed for.
  return `<img src="${escapeHtml(src)}" alt="${alt}">`;
}

/**
 * Inline formatting, applied to text that has already been HTML-escaped.
 *
 * Each rule that emits a tag parks it and leaves a placeholder behind, and the
 * placeholders are swapped back only once every rule has run. Without that, the
 * emphasis rules at the end rewrite the tags the earlier rules built: a URL
 * carrying two `_` — which every presigned URL does — comes out with an `<em>`
 * spliced into the middle of the `href` or `src`, and the image or link is dead.
 */
function inline(escaped: string, images: ImageUrls, unavailable: string): string {
  const held: string[] = [];
  const hold = (html: string) => `${HOLD_OPEN}${held.push(html) - 1}${HOLD_CLOSE}`;

  let out = escaped;
  // Inline code first, so nothing below reads what is inside a code span.
  out = out.replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  // Images before links: `![alt](url)` contains `[alt](url)`, so the link rule
  // would otherwise consume it and leave a stray `!`.
  out = out.replace(IMAGE, (whole, alt: string, url: string) => {
    const html = image(alt, url, images, unavailable);
    return html === null ? whole : hold(html);
  });
  // Same bounded classes as `IMAGE`, for the same reason: a label that could run
  // past the next `[` made a line of unclosed brackets quadratic to scan. The
  // trade is that a label cannot itself contain `[`, and a URL cannot contain
  // `(` — the latter never worked anyway, since the closing `)` was already
  // outside the class.
  out = out.replace(/\[([^[\]\n]+)\]\(([^()\s]+)\)/g, (whole, label: string, url: string) => {
    const href = safeUrl(url);
    if (href === null) return label;
    // The label stays in the open text, so a link may still hold emphasis.
    const open = `<a href="${href}" target="_blank" rel="noopener noreferrer">`;
    return `${hold(open)}${label}${hold('</a>')}`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  return out.replace(
    new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g'),
    (_, index: string) => held[Number(index)]!,
  );
}

/**
 * A body as HTML.
 *
 * `unavailable` is the words shown in place of an image whose attachment is gone
 * and whose reference carries no alt text of its own. It is passed in rather
 * than written here because it is the one string this module puts on screen, and
 * this module is not a React one — it cannot reach the dictionary. The caller
 * that can is `components/Markdown.tsx`. It defaults to nothing so a caller with
 * no reader in front of it (the test suite) is not made to pick a language.
 */
export function renderMarkdown(
  source: string,
  images: ImageUrls = null,
  unavailable = '',
): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const renderInline = (text: string) => inline(text, images, unavailable);

  let inCode = false;
  let codeBuffer: string[] = [];
  let listKind: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listKind) {
      html.push(`</${listKind}>`);
      listKind = null;
    }
  };
  const closeQuote = () => {
    if (quote.length > 0) {
      html.push(
        `<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`,
      );
      quote = [];
    }
  };
  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (const raw of lines) {
    const line = raw;

    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${codeBuffer.map(escapeHtml).join('\n')}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        closeBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (line.trim() === '') {
      closeBlocks();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeBlocks();
      html.push('<hr>');
      continue;
    }

    const ulItem = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olItem = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ulItem || olItem) {
      closeParagraph();
      closeQuote();
      const kind: 'ul' | 'ol' = ulItem ? 'ul' : 'ol';
      if (listKind !== kind) {
        closeList();
        html.push(`<${kind}>`);
        listKind = kind;
      }
      const text = ulItem ? ulItem[1] : olItem![1];
      html.push(`<li>${renderInline(escapeHtml(text))}</li>`);
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      closeParagraph();
      closeList();
      quote.push(escapeHtml(blockquote[1]));
      continue;
    }

    // Plain text: part of the current paragraph.
    closeList();
    closeQuote();
    paragraph.push(escapeHtml(line));
  }

  if (inCode) {
    // An unterminated fence still renders its captured lines.
    html.push(`<pre><code>${codeBuffer.map(escapeHtml).join('\n')}</code></pre>`);
  }
  closeBlocks();
  return html.join('\n');
}


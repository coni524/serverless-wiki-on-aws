// The Markdown surface of the app: `react-markdown` configured once, plus the
// pure helpers around it that are not about rendering.
//
// `react-markdown` builds React elements rather than a string of HTML, so there
// is no `dangerouslySetInnerHTML` here and no escaping rule for this file to get
// right — the class of bug where a body smuggles markup into the page is gone
// with the string. Raw HTML in a body stays inert unless `rehype-raw` is added,
// which is deliberately not.
//
// Nothing here imports Cloudscape, which is what lets the test suite render this
// module to static markup (`test/unit/markdown.test.tsx`); Cloudscape ships CSS
// that Node cannot load. The Cloudscape shell is `components/Markdown.tsx`.

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useMemo } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * Return a link target only if it is provably safe, otherwise null.
 *
 * Deny by default: a scheme is allowed only when it is http(s) or mailto; every
 * other scheme (`javascript:`, `data:`, …) is rejected, and so is a
 * protocol-relative `//host`. Control characters are stripped up front —
 * browsers remove a leading control char before resolving the scheme, so
 * `javascript:` would otherwise masquerade as a scheme-less relative path
 * and slip through.
 *
 * This is stricter than `react-markdown`'s own `defaultUrlTransform`, which also
 * admits `irc`, `ircs`, and `xmpp`. A Wiki body has no use for those, and a
 * scheme the app does not need is a scheme it does not have to reason about.
 */
export function safeUrl(url: string): string | null {
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
 * bucket rules out. So the body holds the id, and the reader signs it at render
 * time — see `createAttachmentDownloadUrls` in `aws-blocks/index.ts`.
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
 * This regular expression is only used to collect ids for signing, never to
 * render — the rendering is `react-markdown`'s. It stays deliberately narrow
 * (no `[` in the alt, no `(` or whitespace in the URL) so that one pass over a
 * body stays linear: a body is up to 1 MiB of text anyone with `write` can save,
 * and a class that ran to the end of the input and backtracked would let one
 * page freeze every reader's tab.
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
 * The URL rewrite `react-markdown` applies to every href and src it finds.
 *
 * Everything is checked here, once, so a component below never has to look at a
 * scheme again. `attachment:` is the single exception, because it is our own
 * scheme and `safeUrl` would refuse it: it is handed through for `MarkdownImage`
 * to resolve. Every other image target arrives at that component already
 * checked, so removing the component would narrow what a body can do rather
 * than open it up.
 */
const urlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && url.startsWith(ATTACHMENT_SCHEME)) return url;
  return safeUrl(url) ?? '';
};

/**
 * One `![alt](url)`.
 *
 * Only an attachment of this page becomes an `<img>`. Every other target — an
 * external URL above all — renders as a link, not an embed. Rendering a remote
 * image would have the reader's browser fetch it on open, telling that host who
 * read the page and when, and no page needs that to show a picture it owns.
 *
 * What `images` holds is usually a `blob:` URL for bytes already in the
 * attachment cache; a presigned URL reaches here only when that cache is
 * unavailable. No `loading="lazy"`, for the sake of the second case: a deferred
 * image is fetched whenever it scrolls into view, and by then a URL signed at
 * render time may have expired — the download window is 60 seconds.
 */
function MarkdownImage({
  src,
  alt,
  title,
  images,
  unavailable,
}: {
  src: string | undefined;
  alt: string | undefined;
  title: string | undefined;
  images: ImageUrls;
  unavailable: string;
}): ReactNode {
  const text = alt || unavailable;

  if (src === undefined || !src.startsWith(ATTACHMENT_SCHEME)) {
    // Already through `urlTransform`, which empties what it refuses.
    const href = src === undefined || src === '' ? null : src;
    if (href === null) return text;
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    );
  }

  const id = src.slice(ATTACHMENT_SCHEME.length);
  if (!ATTACHMENT_ID.test(id)) return text;
  // Not yet signed: render nothing, so the alt text does not flash into view and
  // out again as the URLs land.
  if (images === null) return null;
  // `Object.hasOwn` rather than a plain lookup: `images` is a plain object from
  // the API, so `attachment:toString` would otherwise read a function off its
  // prototype and hand it to the `src` attribute.
  const url = Object.hasOwn(images, id) ? images[id] : undefined;
  if (url === undefined) return text;
  return <img src={url} alt={alt ?? ''} title={title} />;
}

/**
 * One `[label](url)`.
 *
 * `urlTransform` has already emptied any href it refused, and a link that
 * points nowhere is not a link: its label stays as text, which is what a reader
 * of a body that wrote `[x](javascript:…)` should see.
 *
 * A link into the page itself is followed here rather than by the browser. The
 * app routes on the whole hash (`src/lib/router.tsx`), so letting `#…` reach the
 * address bar would replace the route with one that parses to "not found" — and
 * with `target="_blank"`, in a second tab. These links are `remark-gfm`'s
 * footnotes: the reference down to the note and the arrow back up.
 *
 * Everything else opens in a new tab. The app is a single page, and a body's
 * link is to somewhere else.
 */
function MarkdownLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string | undefined; children: ReactNode }) {
  if (!href) return <>{children}</>;

  if (href.startsWith('#')) {
    return (
      <a
        href={href}
        {...rest}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(href.slice(1))?.scrollIntoView({ block: 'center' });
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

/**
 * A body, rendered.
 *
 * `unavailable` is the words shown in place of an image whose attachment is gone
 * and whose reference carries no alt text of its own. It is passed in because it
 * is the one string this module puts on screen that is not the body's own, and
 * the dictionary is read by the caller (`components/Markdown.tsx`). It defaults
 * to nothing so a caller with no reader in front of it (the test suite) is not
 * made to pick a language.
 *
 * `footnoteLabel` names the heading `remark-gfm` puts above the notes it
 * collects. It is only ever read aloud — the stylesheet takes it off the screen
 * — but it is still one of this app's strings, so it comes from the dictionary
 * with the rest.
 *
 * `remark-gfm` adds tables, task lists, strikethrough, footnotes, and autolinks.
 * `remark-breaks` makes a single newline a line break, which is not CommonMark
 * but is how every body in this Wiki was written: the renderer this replaced
 * broke on every newline, and without it a saved page would silently reflow.
 */
export function MarkdownBody({
  source,
  images = null,
  unavailable = '',
  footnoteLabel = 'Footnotes',
}: {
  source: string;
  images?: ImageUrls;
  unavailable?: string;
  footnoteLabel?: string;
}) {
  // Rebuilt when the signed URLs land, which is exactly when the images must be
  // drawn again. Anything else in a body renders the same either way.
  //
  // `node` is dropped from both: react-markdown hands over the syntax tree entry
  // alongside the element's own props, and React would put it on the DOM. What
  // is left through — `title`, and the ids that tie a footnote to its reference
  // — is the element's own.
  const components = useMemo<Components>(
    () => ({
      img: ({ node, src, alt, title }) => (
        <MarkdownImage
          src={typeof src === 'string' ? src : undefined}
          alt={alt}
          title={title}
          images={images}
          unavailable={unavailable}
        />
      ),
      a: ({ node, href, children, ...rest }) => (
        <MarkdownLink href={href} {...rest}>
          {children}
        </MarkdownLink>
      ),
    }),
    [images, unavailable],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      remarkRehypeOptions={{ footnoteLabel }}
      urlTransform={urlTransform}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
}

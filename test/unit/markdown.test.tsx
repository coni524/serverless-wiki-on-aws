/**
 * Unit tests for the Markdown surface: what a body is allowed to put on screen,
 * and which of its images become pictures.
 *
 * The renderer is `react-markdown`, so these render to static markup and read
 * the result rather than calling a string function. What they pin down is not
 * `react-markdown`'s own behaviour — that is its test suite's job — but the
 * decisions this app layers on top: an image is an attachment of the page or it
 * is not an image, a refused URL is not a link, and a body cannot become markup.
 *
 * `src/lib/markdown.tsx` imports no Cloudscape, which is what lets this file
 * load it at all: Cloudscape ships CSS that Node cannot import.
 *
 * Run with: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MAX_IMAGE_REFS,
  MarkdownBody,
  collectAttachmentRefs,
  safeUrl,
  type ImageUrls,
} from '../../src/lib/markdown.js';

/** A body as the HTML a reader's browser would receive. */
const render = (source: string, images: ImageUrls = {}, unavailable = ''): string =>
  renderToStaticMarkup(<MarkdownBody source={source} images={images} unavailable={unavailable} />);

// ─── Images in a page body ───────────────────────────────────────────────────
// The boundary the renderer draws: an image is an attachment of this page or it
// is not an image at all, and a body that outlives its picture still renders.

test('an image renders only from a signed attachment of the page', () => {
  const body = '![図](attachment:att1)';

  assert.match(
    render(body, { att1: 'https://s3.example/att1?sig=a&exp=1' }),
    /<img src="https:\/\/s3\.example\/att1\?sig=a&amp;exp=1" alt="図"\/?>/,
    'The signed URL is escaped into the attribute, ampersands and all',
  );
  assert.match(
    render(body, {}, '（画像は表示できません）'),
    /図/,
    'A picture that is gone leaves its alt text, not a broken page',
  );
  assert.doesNotMatch(render(body, null), /図/, 'Nothing shows before the URLs arrive');
});

test('an image with no alt text of its own falls back to the words handed in', () => {
  const html = render('![](attachment:gone)', {}, '（画像は表示できません）');

  assert.match(html, /（画像は表示できません）/);
  assert.doesNotMatch(html, /<img/);
});

test('an id naming an inherited property renders as a missing image, not a crash', () => {
  // `images` is a plain object from the API. Reading `images['toString']` off
  // its prototype would hand a function to the `src` attribute, and one line in
  // one body would blank the whole app for every reader of that page.
  for (const id of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const html = render(`![図](attachment:${id})`, { att1: 'https://s3/x' });

    assert.doesNotMatch(html, /<img/, `attachment:${id} must not become an image`);
    assert.match(html, /図/);
  }
});

test('a remote image is left as a link rather than embedded', () => {
  // Embedding it would have the reader's browser call that host on open, which
  // tells the host who read the page and when.
  const html = render('![tracker](https://evil.example/pixel.png)', {});

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/evil\.example\/pixel\.png"[^>]*>tracker<\/a>/);
});

test('an image reference cannot smuggle markup through its alt text', () => {
  const html = render('![" onerror="alert(1)](attachment:att1)', { att1: 'https://s3/x' });

  assert.doesNotMatch(html, /onerror="alert/);
  assert.match(html, /&quot; onerror=&quot;alert\(1\)/);
});

test('collectAttachmentRefs takes each id once and drops what cannot be one', () => {
  const body = [
    '![a](attachment:att1)',
    '![b](attachment:att1)',
    '![c](attachment:../../secret)',
    '![d](https://example.com/x.png)',
    '![e](attachment:att2)',
  ].join('\n\n');

  assert.deepStrictEqual(collectAttachmentRefs(body), ['att1', 'att2']);
});

test('collectAttachmentRefs stops at the number the API will sign', () => {
  const body = Array.from({ length: MAX_IMAGE_REFS + 5 }, (_, i) => `![](attachment:id${i})`).join(
    '\n\n',
  );

  assert.strictEqual(collectAttachmentRefs(body).length, MAX_IMAGE_REFS);
});

// ─── Links ───────────────────────────────────────────────────────────────────

test('a link is admitted only for a scheme the Wiki has a use for', () => {
  assert.strictEqual(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(safeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
  assert.strictEqual(safeUrl('/spaces/x'), '/spaces/x', 'A relative target is a link');
  assert.strictEqual(safeUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeUrl('data:text/html,<script>'), null);
  assert.strictEqual(safeUrl('//evil.example/x'), null, 'Protocol-relative is external');
  // A browser drops a leading control character before it resolves the scheme,
  // so this reaches the page as `javascript:` however it was written.
  assert.strictEqual(safeUrl('javascript:alert(1)'), null);
  // Stricter than react-markdown's own default, which admits these three.
  assert.strictEqual(safeUrl('irc://example.com/x'), null);
  assert.strictEqual(safeUrl('xmpp:someone@example.com'), null);
});

test('a refused link keeps its label as text and points nowhere', () => {
  const html = render('[押して](javascript:alert(1))', {});

  assert.doesNotMatch(html, /<a /, 'A link that points nowhere is not a link');
  assert.match(html, /押して/);
});

test('a link opens in a new tab and cannot reach back into the app', () => {
  assert.match(
    render('[資料](https://example.com/a)', {}),
    /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">資料<\/a>/,
  );
});

test('a footnote keeps the ids that tie it to its reference, and stays in this tab', () => {
  // The app routes on the whole hash, so a footnote followed as a URL would
  // replace the route with one that parses to "not found" — in a second tab, at
  // that. `MarkdownLink` takes these over: no `target`, and the ids survive so
  // there is something to scroll to.
  const html = renderToStaticMarkup(
    <MarkdownBody source={'本文[^1]\n\n[^1]: 注記'} images={{}} footnoteLabel="脚注" />,
  );

  assert.match(html, /<a href="#user-content-fn-1"[^>]*id="user-content-fnref-1"/);
  assert.doesNotMatch(html, /href="#user-content-fn-1"[^>]*target="_blank"/);
  assert.match(html, /<li id="user-content-fn-1">/, 'The note is there to scroll to');
  assert.match(html, /id="footnote-label"[^>]*>脚注</, 'Its heading comes from the dictionary');
});

test('the title of a link survives', () => {
  assert.match(render('[資料](https://example.com/a "説明")', {}), /title="説明"/);
});

// ─── What a body may not become ──────────────────────────────────────────────

test('raw HTML in a body stays inert', () => {
  // `rehype-raw` is deliberately not installed. Without it a body's own tags are
  // text, which is the property that lets the assistant panel render a reply
  // that quoted a page.
  const html = render('<img src=x onerror="alert(1)"> と <b>太字</b>', {});

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;太字&lt;\/b&gt;/, 'The tags a body wrote arrive as characters');
});

test('a script tag written in a body is text, not a script', () => {
  const html = render('<script>alert(1)</script>', {});

  assert.doesNotMatch(html, /<script/);
});

// ─── GFM and the line breaks this Wiki was written with ──────────────────────

test('a table renders as a table', () => {
  const html = render(['| 名前 | 値 |', '| --- | --- |', '| a | 1 |'].join('\n'), {});

  assert.match(html, /<table>/);
  assert.match(html, /<th>名前<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test('a nested list keeps its nesting', () => {
  const html = render(['- 親', '  - 子', '    - 孫'].join('\n'), {});

  assert.match(html, /<ul>\s*<li>親\s*<ul>\s*<li>子\s*<ul>\s*<li>孫/);
});

test('a task list renders its checkboxes, checked as written', () => {
  const html = render(['- [ ] まだ', '- [x] 済み'].join('\n'), {});

  assert.match(html, /<input type="checkbox" disabled=""\/?>\s*まだ/);
  assert.match(html, /checked=""\/?>\s*済み/);
});

test('strikethrough renders', () => {
  assert.match(render('~~取り消し~~', {}), /<del>取り消し<\/del>/);
});

test('a single newline inside a paragraph stays a line break', () => {
  // Not CommonMark, which folds it into a space — but it is how every body in
  // this Wiki was written, because the renderer this replaced broke on every
  // newline. Without `remark-breaks` a saved page would silently reflow.
  assert.match(render('一行目\n二行目', {}), /一行目<br\/?>\s*\n?二行目/);
});

test('an underscore inside a word is not emphasis', () => {
  // The renderer this replaced turned `a_b_c` into `a<em>b</em>c`, which broke
  // every identifier a body mentioned. CommonMark's flanking rules do not.
  const html = render('snake_case_name と _強調_', {});

  assert.match(html, /snake_case_name/);
  assert.match(html, /<em>強調<\/em>/);
});

test('a fenced code block keeps its contents verbatim', () => {
  const html = render(['```js', 'const a = "<b>" & 1_2;', '```'].join('\n'), {});

  assert.match(html, /<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot; &amp; 1_2;/);
});

// ─── Cost of rendering ───────────────────────────────────────────────────────

test('a body of unclosed brackets renders without stalling the reader', () => {
  // The renderer this replaced scanned to the end of the line and backtracked a
  // character at a time looking for a `]` that was never there — one full scan
  // per `[` in the body — and wedged the tab of everyone who opened the page.
  // `micromark` underneath `react-markdown` is linear, and `collectAttachmentRefs`
  // keeps the bounded classes that made it so. A megabyte of body is well within
  // what `MAX_BODY_BYTES` allows anyone with `write` to save.
  const bodies = ['['.repeat(200_000), '!['.repeat(100_000), '![]('.repeat(50_000)];

  for (const body of bodies) {
    const started = Date.now();
    render(body, {});
    const took = Date.now() - started;
    assert.ok(took < 5000, `${JSON.stringify(body.slice(0, 4))}… took ${took}ms`);
  }

  // `collectAttachmentRefs` reads the whole body rather than one line, so it is
  // the same rule over more text.
  const started = Date.now();
  collectAttachmentRefs('!['.repeat(100_000));
  assert.ok(Date.now() - started < 2000);
});

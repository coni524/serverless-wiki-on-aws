import Box from '@cloudscape-design/components/box';
import { useT } from '../i18n';
import { renderMarkdown, type ImageUrls } from '../markdown';

/**
 * Render Markdown as sanitized HTML. The only Markdown surface in the app.
 *
 * The rendering itself lives in `src/markdown.ts`; this is the React shell
 * around it. `images` carries the signed URL for each attachment the body
 * embeds. Left out, the body still renders in full and its images stay blank —
 * which is what a caller with no page to sign against (a preview, a snippet)
 * should show.
 *
 * The renderer puts one string of its own on screen — what stands in for an
 * image it cannot resolve — and takes it from here, because this is the side of
 * the boundary that can read the dictionary.
 */
export function Markdown({ source, images = null }: { source: string; images?: ImageUrls }) {
  const t = useT();
  if (source.trim() === '') {
    return <Box color="text-status-inactive">{t.page.emptyBodyInline}</Box>;
  }
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(source, images, t.page.imageUnavailable),
      }}
    />
  );
}

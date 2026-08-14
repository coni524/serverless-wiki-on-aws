import Box from '@cloudscape-design/components/box';
import { useT } from '@/lib/i18n';
import { MarkdownBody, type ImageUrls } from '@/lib/markdown';

/**
 * Render Markdown. The only Markdown surface in the app.
 *
 * The rendering itself lives in `src/lib/markdown.tsx`; this is the shell around
 * it, and it exists to keep Cloudscape and the dictionary out of that module —
 * which is what makes the renderer testable outside a browser.
 *
 * `images` carries the signed URL for each attachment the body embeds. Left out,
 * the body still renders in full and its images stay blank, which is what a
 * caller with no page to sign against (an assistant's reply, a preview) should
 * show.
 */
export function Markdown({ source, images = null }: { source: string; images?: ImageUrls }) {
  const t = useT();
  if (source.trim() === '') {
    return <Box color="text-status-inactive">{t.page.emptyBodyInline}</Box>;
  }
  return (
    <div className="markdown">
      <MarkdownBody
        source={source}
        images={images}
        unavailable={t.page.imageUnavailable}
        footnoteLabel={t.page.footnotesLabel}
      />
    </div>
  );
}

import { useRef, useState } from 'react';
import { api } from 'aws-blocks';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { useT } from '@/lib/i18n';
import { errMessage } from '@/utils/errors';

/**
 * Image types the editor embeds: the ones every current browser draws in an
 * `<img>`, which is a narrower set than the server stores.
 *
 * Two kinds of type are left out on purpose. `image/svg+xml` is absent from
 * `ALLOWED_CONTENT_TYPES` in `aws-blocks/index.ts` because an SVG can carry
 * script, so an uploaded one is served as an opaque download and no `<img>` will
 * ever draw it. HEIC, HEIF and TIFF are stored happily but Chrome and Firefox
 * decline to draw them. Either way the body would keep a reference to a picture
 * the reader cannot see, so the editor refuses the file instead and says why.
 */
const EMBEDDABLE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

/**
 * A file name as alt text.
 *
 * `]` in the name would close the label early: the reference would stop matching
 * the image rule in `src/markdown.ts` and render as bare text, with the upload
 * itself having succeeded and nothing on screen to explain it. The brackets and
 * any line break come out of the label; the stored file name, which the download
 * serves back, keeps them.
 */
const altText = (filename: string) => filename.replace(/[[\]\r\n]/g, ' ').trim();

/** What a body writes to point at one of the page's attachments. */
const imageRef = (filename: string, attachmentId: string) =>
  `![${altText(filename)}](attachment:${attachmentId})`;

/**
 * The title + Markdown body form, shared by page creation and editing. Body
 * saves are last-writer-wins with no version guard, so there is no
 * conflict handling here by design.
 *
 * One column decides the width of everything. Left alone, `FormField` narrows
 * its control to eight of the layout's twelve columns while `Form` right-aligns
 * the buttons against the full width, so the fields and the buttons end at
 * different places. Here the eight columns are taken by the whole form, the
 * fields are told to fill them (`stretch`), and the buttons land on the same
 * edge as the fields.
 *
 * An image dropped or pasted onto the body is uploaded as an attachment of this
 * page and referenced from the text; see `dropImages`.
 */
export function PageEditor({
  pageId,
  initialTitle = '',
  initialBody = '',
  submitLabel,
  busy = false,
  onSubmit,
  onCancel,
}: {
  /** The page the body belongs to — where a dropped image is attached. */
  pageId: string;
  initialTitle?: string;
  initialBody?: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nextPlaceholder = useRef(0);

  /**
   * The `<textarea>` Cloudscape renders.
   *
   * The component exposes no ref to its own element and no paste or drop
   * handler, so the events are caught on the wrapper — they bubble — and the
   * element is found underneath it. Insertion needs the real element, because
   * where the text goes is the caret, which lives only in the DOM.
   */
  const textarea = () => bodyRef.current?.querySelector('textarea') ?? null;

  /** Put `text` where the caret is, and leave the caret after it. */
  const insertAtCaret = (text: string) => {
    const el = textarea();
    setBody((current) => {
      const at = el === null ? current.length : el.selectionStart;
      return current.slice(0, at) + text + current.slice(at);
    });
    if (el !== null) {
      const at = el.selectionStart + text.length;
      // After React has written the new value back into the element.
      requestAnimationFrame(() => el.setSelectionRange(at, at));
    }
  };

  /**
   * Upload each image and reference it from the body.
   *
   * A marker goes in at the caret first and is swapped for the real reference
   * when that upload lands, so the author can keep typing while the bytes are in
   * flight and several images dropped at once each end up where they were
   * dropped. An upload that fails takes its own marker back out; the body is
   * never left holding a reference to something that is not in S3.
   *
   * The upload itself is the same two steps the attachment list uses: the API
   * signs, the browser PUTs to S3. So a pasted image is an ordinary
   * attachment of the page and appears in that list too.
   */
  const dropImages = async (files: File[]) => {
    const images = files.filter((file) => EMBEDDABLE_IMAGE.test(file.type));
    const skipped = files.length - images.length;
    // Say what was left behind either way. A file the editor drops silently
    // looks to the author like an upload that worked.
    const refusal = t.page.embeddableTypes;
    if (images.length === 0) {
      setUploadError(refusal);
      return;
    }
    setUploadError(skipped === 0 ? null : t.page.skippedFiles(skipped, refusal));

    const marked = images.map((file) => {
      const filename = file.name.trim() === '' ? pastedName(file.type) : file.name;
      // Not a dictionary entry, and deliberately so: this marker goes into the
      // body text, which is saved if the author submits before an upload lands.
      // The language the screen is drawn in must not reach what is stored.
      const marker = `![Uploading… ${altText(filename)}](uploading:${nextPlaceholder.current++})`;
      return { file, filename, marker };
    });
    insertAtCaret(`${marked.map((m) => m.marker).join('\n')}\n`);

    setUploading((n) => n + marked.length);
    await Promise.all(
      marked.map(async ({ file, filename, marker }) => {
        try {
          const grant = await api.createAttachmentUploadUrl({
            pageId,
            filename,
            contentType: file.type,
            size: file.size,
          });
          // The signed content type, not the file's: it is baked into the
          // signature, so S3 rejects a PUT that declares anything else.
          const put = await fetch(grant.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': grant.contentType },
            body: file,
          });
          if (!put.ok) throw new Error(t.page.uploadFailed(put.status));
          setBody((current) =>
            current.replace(marker, imageRef(grant.filename, grant.attachmentId)),
          );
        } catch (e) {
          setBody((current) => current.replace(`${marker}\n`, '').replace(marker, ''));
          setUploadError(errMessage(e));
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
  };

  const canSubmit = title.trim().length > 0 && !busy && uploading === 0;

  return (
    <Grid gridDefinition={[{ colspan: { default: 12, m: 8 } }]}>
      <form onSubmit={(e) => e.preventDefault()}>
        <Form
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button disabled={busy} onClick={onCancel}>
                {t.common.cancel}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!canSubmit}
                onClick={() => onSubmit(title.trim(), body)}
              >
                {submitLabel}
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="m">
            <FormField label={t.page.titleLabel} stretch>
              <Input value={title} autoFocus onChange={(e) => setTitle(e.detail.value)} />
            </FormField>
            <FormField label={t.page.bodyLabel} description={t.page.bodyDescription} stretch>
              {/* The wrapper is what listens. See `textarea` above for why. */}
              <div
                ref={bodyRef}
                onDragOver={(e) => {
                  // Without this the browser opens the dropped file instead,
                  // navigating away from the half-written page.
                  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                }}
                onDrop={(e) => {
                  const files = [...e.dataTransfer.files];
                  if (files.length === 0) return;
                  e.preventDefault();
                  void dropImages(files);
                }}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files];
                  // Only take over a paste that carries files; a paste of text
                  // must still behave like a paste of text.
                  if (files.length === 0) return;
                  e.preventDefault();
                  void dropImages(files);
                }}
              >
                <Textarea value={body} rows={20} onChange={(e) => setBody(e.detail.value)} />
              </div>
            </FormField>
            {uploading > 0 && (
              <Alert type="info">{t.page.uploadingImages(uploading)}</Alert>
            )}
            {uploadError !== null && (
              <Alert type="error" dismissible onDismiss={() => setUploadError(null)}>
                {uploadError}
              </Alert>
            )}
          </SpaceBetween>
        </Form>
      </form>
    </Grid>
  );
}

/**
 * A name for an image that arrived without one.
 *
 * A clipboard image usually has an empty `name`, and the name is what the
 * download serves the file back as, so an invented one still has to
 * carry the right extension.
 */
function pastedName(contentType: string): string {
  const extension = contentType.split('/')[1] ?? 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `pasted-${stamp}.${extension}`;
}

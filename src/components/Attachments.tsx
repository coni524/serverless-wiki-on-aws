import { useState } from 'react';
import { api } from 'aws-blocks';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FileInput from '@cloudscape-design/components/file-input';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useDateTimeFormat, useT } from '../i18n';
import { errMessage, formatBytes, useAsync, type Attachment } from '../lib';
import { forgetAttachment } from '../attachment-cache';

/**
 * A page's attachments. Uploads and downloads go browser-to-S3 over a
 * short-lived presigned URL; the API only gates and signs. The
 * upload MUST send the server-returned `contentType` as its `Content-Type`,
 * because that value is signed into the URL and may have been narrowed to the
 * type allow-list — sending the raw file type would make S3 reject the PUT.
 */
export function Attachments({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  const t = useT();
  const dateTime = useDateTimeFormat();
  const { data, error, loading, reload } = useAsync(() => api.listAttachments(pageId), [pageId]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Attachment | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setActionError(null);
    try {
      const grant = await api.createAttachmentUploadUrl({
        pageId,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      });
      const put = await fetch(grant.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': grant.contentType },
        body: file,
      });
      if (!put.ok) throw new Error(t.page.uploadFailed(put.status));
      reload();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async (attachment: Attachment) => {
    setActionError(null);
    try {
      const { downloadUrl } = await api.createAttachmentDownloadUrl(pageId, attachment.attachmentId);
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setActionError(errMessage(e));
    }
  };

  const remove = async (attachment: Attachment) => {
    setConfirming(null);
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteAttachment(pageId, attachment.attachmentId);
      // The id is only in hand here. Nothing else can find these bytes once the
      // attachment is gone, so this is the one chance to drop them.
      await forgetAttachment(attachment.attachmentId);
      reload();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const items = data?.items ?? [];

  return (
    <Container
      header={
        <Header
          variant="h2"
          counter={items.length > 0 ? `(${items.length})` : undefined}
          actions={
            canEdit ? (
              <FileInput
                variant="button"
                value={[]}
                onChange={(e) => {
                  const file = e.detail.value[0];
                  if (file) void upload(file);
                }}
              >
                {busy ? t.page.working : t.page.addFile}
              </FileInput>
            ) : undefined
          }
        >
          {t.page.attachments}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {actionError !== null && <Alert type="error">{actionError}</Alert>}
        {error !== null && <Alert type="error">{error}</Alert>}

        <Table
          variant="embedded"
          loading={loading}
          loadingText={t.common.loading}
          items={items}
          trackBy={(attachment) => attachment.attachmentId}
          columnDefinitions={[
            {
              id: 'filename',
              header: t.page.columnFilename,
              cell: (attachment) => (
                <Link onFollow={() => void download(attachment)}>{attachment.filename}</Link>
              ),
            },
            {
              id: 'size',
              header: t.page.columnSize,
              cell: (attachment) => formatBytes(attachment.size),
            },
            {
              id: 'uploadedAt',
              header: t.page.columnUploadedAt,
              cell: (attachment) => dateTime(attachment.uploadedAt),
            },
            ...(canEdit
              ? [
                  {
                    id: 'actions',
                    header: '',
                    cell: (attachment: Attachment) => (
                      <Button
                        variant="inline-link"
                        disabled={busy}
                        onClick={() => setConfirming(attachment)}
                      >
                        {t.common.delete}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          empty={<Box color="text-status-inactive">{t.page.noAttachments}</Box>}
        />
      </SpaceBetween>

      {confirming !== null && (
        <Modal
          visible
          header={t.page.deleteAttachment}
          onDismiss={() => setConfirming(null)}
          footer={
            <Box float="right">
              <SpaceBetween size="xs" direction="horizontal">
                <Button onClick={() => setConfirming(null)}>{t.common.cancel}</Button>
                <Button variant="primary" onClick={() => void remove(confirming)}>
                  {t.common.delete}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {t.page.deleteAttachmentBody(confirming.filename)}
        </Modal>
      )}
    </Container>
  );
}

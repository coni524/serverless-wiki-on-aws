/**
 * The rows of a page's attachments — filenames, sizes, upload times.
 *
 * The bytes are a different subject and live in `attachment-cache.ts`: this
 * module holds what the API lists, that one holds what the browser stores.
 *
 * A download URL is deliberately absent from both. Every download and every
 * image render asks the API to sign the id afresh, because signing is where
 * `read` is re-evaluated (ADR-0004's presigned-URL contract), and a signature
 * held in a cache would outlive the permission that produced it.
 */
import { api } from 'aws-blocks';
import { type QueryKey } from '@tanstack/react-query';
import { queryClient } from '@/lib/react-query';

export const attachmentsKey = (pageId: string): QueryKey => ['attachments', pageId];

type AttachmentList = Awaited<ReturnType<typeof api.listAttachments>>;

export function attachmentsQuery(pageId: string) {
  return { queryKey: attachmentsKey(pageId), queryFn: () => api.listAttachments(pageId) };
}

/**
 * A file was uploaded.
 *
 * The upload grant names the key, not the row: the id, the recorded size, and
 * the upload time are the server's to state, so the list is asked again. The
 * rows already drawn stay on screen while that runs.
 */
export function noteUploadedAttachment(pageId: string): void {
  void queryClient.invalidateQueries({ queryKey: attachmentsKey(pageId) });
}

/**
 * An attachment was deleted. The row is the whole change and the caller is
 * holding its id, so it leaves the table at once rather than after a refetch.
 */
export function noteDeletedAttachment(pageId: string, attachmentId: string): void {
  queryClient.setQueryData<AttachmentList>(attachmentsKey(pageId), (prev) =>
    prev === undefined
      ? prev
      : { ...prev, items: prev.items.filter((item) => item.attachmentId !== attachmentId) },
  );
}

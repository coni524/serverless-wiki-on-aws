import { useEffect, useState } from 'react';
import { api } from 'aws-blocks';
import { useIsRestoring } from '@tanstack/react-query';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useDateTimeFormat, useT } from '@/lib/i18n';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import { freshnessAgrees, resetServerState, usePage } from '@/features/pages/api/page-cache';
import { hrefHome, hrefNode, hrefPage, hrefSpace, navigate } from '@/lib/router';
import { collectAttachmentRefs } from '@/lib/markdown';
import { cachedImageUrls, revokeImageUrls } from '@/features/pages/api/attachment-cache';
import { Markdown } from '@/components/Markdown';
import { PageEditor } from '@/features/pages/components/PageEditor';
import { Attachments } from '@/features/pages/components/Attachments';

type Mode = 'view' | 'edit';

/**
 * One page: its breadcrumb, body, attachments, and — when the caller holds
 * write on the space — the action that edits it.
 *
 * Adding, renaming, and deleting pages are not here. They act on a page's place
 * in the space rather than on its body, and they belong to the row that shows
 * that place: the controls appear on the tree row under the pointer
 * (`PageTree`). What is left in this header is the one action that is about the
 * text in front of the reader.
 */
export function PageView({
  spaceId,
  spaceName,
  pageId,
  editable,
  onBreadcrumb,
}: {
  spaceId: string;
  spaceName: string;
  pageId: string;
  editable: boolean;
  /** Reports which space the path was read in, so a stale one is not applied elsewhere. */
  onBreadcrumb: (spaceId: string, ancestorIds: string[]) => void;
}) {
  const t = useT();
  const dateTime = useDateTimeFormat();
  // The query hands over whatever body is held — read this session or restored
  // from the persisted cache — and refetches on every mount. Whether the held
  // body may be *drawn* before the refetch answers is not the query's call: it
  // is the stamp's (`freshnessAgrees` below).
  const { data: page, error: queryError, isFetching } = usePage(pageId);
  // True while the persisted cache is still being restored. In that window a
  // query renders as idle even though its mount refetch has not started, so
  // without this flag a restored body could slip through the fetching check
  // below before the stamp had anything to say.
  const isRestoring = useIsRestoring();
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (page) onBreadcrumb(spaceId, page.breadcrumb.map((b) => b.pageId));
  }, [page, spaceId, onBreadcrumb]);

  // A fresh page id resets any transient UI from the previous page.
  useEffect(() => {
    setMode('view');
    setActionError(null);
  }, [pageId]);

  // A page can go missing while it is open — the AI assistant deletes through
  // the API, not through this view, so nothing here navigates away first. The
  // error is the truth; what it must not be is a dead end, hence the way back.
  if (queryError) return <PageUnavailable spaceId={spaceId} error={errMessage(queryError)} />;
  // A held body is shown while the refetch runs only when a listing this
  // session fetched vouches for its stamp. Anything less waits: showing a
  // stale body as current is the failure this screen must not have.
  if (page === undefined || ((isFetching || isRestoring) && !freshnessAgrees(pageId, page))) {
    return <Loading label={t.page.loadingPage} />;
  }

  const title = page.title || t.page.untitled;

  const save = async (nextTitle: string, body: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updatePage(pageId, { title: nextTitle, body });
      // The saved page is not the only stale entry: a rename moves the titles
      // in other pages' breadcrumbs and in the tree's labels too. Dropping
      // everything is the rule; the reset refetches this page and the tree.
      resetServerState();
      setMode('view');
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const breadcrumbs = (
    <BreadcrumbGroup
      ariaLabel={t.page.breadcrumbAria}
      items={[
        { text: t.page.spacesRoot, href: hrefHome() },
        { text: spaceName, href: hrefSpace(spaceId) },
        // Every step carries its own kind, so an ancestor is linked at the
        // screen that can answer for it: after the folder migration they are all
        // folders, and before it some are still pages.
        ...page.breadcrumb.map((ancestor) => ({
          text: ancestor.title || t.page.untitled,
          href: hrefNode(spaceId, ancestor.pageId, ancestor.kind),
        })),
        { text: title, href: hrefPage(spaceId, pageId) },
      ]}
      onFollow={(e) => {
        e.preventDefault();
        navigate(e.detail.href);
      }}
    />
  );

  if (mode === 'edit') {
    return (
      <ContentLayout
        breadcrumbs={breadcrumbs}
        header={<Header variant="h1">{t.page.editHeading}</Header>}
      >
        <SpaceBetween size="m">
          <PageEditor
            pageId={pageId}
            initialTitle={page.title}
            initialBody={page.body}
            submitLabel={t.common.save}
            busy={busy}
            onSubmit={save}
            onCancel={() => setMode('view')}
          />
          {actionError !== null && <ErrorText>{actionError}</ErrorText>}
        </SpaceBetween>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      breadcrumbs={breadcrumbs}
      header={
        <Header
          variant="h1"
          description={t.page.pageMeta(
            page.revision,
            page.updatedAt ? dateTime(page.updatedAt) : null,
          )}
          actions={
            editable ? <Button onClick={() => setMode('edit')}>{t.common.edit}</Button> : undefined
          }
        >
          {title}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {actionError !== null && <ErrorText>{actionError}</ErrorText>}

        {/* No container around the body. A container draws a card — border,
            white fill, its own padding — which is right for one section among
            several and wrong for the thing the page is: the body is the page,
            not a panel on it, and the frame only narrows the text and repeats
            an edge the content area already has. The attachments below keep
            theirs, because that list really is a section beside the body. */}
        {page.body.trim() === '' ? (
          <Box color="text-status-inactive">{t.page.emptyBody}</Box>
        ) : (
          <PageBody pageId={pageId} body={page.body} />
        )}

        <Attachments pageId={pageId} canEdit={editable} />
      </SpaceBetween>
    </ContentLayout>
  );
}

/**
 * The body, with the images it embeds resolved.
 *
 * A body stores an attachment id, never a URL, so the URLs are signed here on
 * every render of the page — which is also where the reader's `read` permission
 * is checked again. Only the ids the body actually mentions are sent,
 * so a page with no images costs no request at all.
 *
 * A failure to sign is not a failure to read: the text renders either way, and
 * the alert says why the pictures are missing.
 */
function PageBody({ pageId, body }: { pageId: string; body: string }) {
  const t = useT();
  const refs = collectAttachmentRefs(body);
  // The ids themselves are the dependency. Re-signing must follow what the body
  // points at, and an edit that only changes prose must not fetch again.
  const key = refs.join(',');
  // `null` while the URLs are in flight, so the images are not briefly shown as
  // alt text — and so the previous page's pictures never appear under this body.
  const [images, setImages] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Written out rather than run through `useAsync`, because the object URLs the
  // cache hands back are owned by this effect: every one of them has to be
  // revoked when the body changes or the view unmounts, including the ones
  // produced by a request that finished after this effect was already torn down.
  useEffect(() => {
    let live = true;
    let held: Record<string, string> | null = null;
    setImages(null);
    setError(null);

    if (refs.length === 0) {
      setImages({});
      return;
    }

    void (async () => {
      try {
        // Signed on every render, as before: this is where `read` is checked
        // again. The cache only avoids the transfer.
        const { urls } = await api.createAttachmentDownloadUrls(pageId, refs);
        const resolved = await cachedImageUrls(urls);
        held = resolved;
        if (!live) {
          revokeImageUrls(resolved);
          return;
        }
        setImages(resolved);
      } catch (e) {
        if (live) setError(errMessage(e));
      }
    })();

    return () => {
      live = false;
      if (held !== null) revokeImageUrls(held);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, key]);

  return (
    <SpaceBetween size="s">
      {error !== null && <ErrorText>{t.page.imagesFailed(error)}</ErrorText>}
      <Markdown source={body} images={images} />
    </SpaceBetween>
  );
}

/**
 * What a page route shows when the page cannot be read.
 *
 * Most often it is gone: the assistant deleted it while it was open, and the
 * shell refetched (`onWriteApplied` in App.tsx). It could equally be a
 * permission that changed. Either way the reason belongs on screen unedited,
 * with a route out of a page that no longer exists.
 */
function PageUnavailable({ spaceId, error }: { spaceId: string; error: string }) {
  const t = useT();
  return (
    <ContentLayout header={<Header variant="h1">{t.page.pageUnavailable}</Header>}>
      <Container>
        <SpaceBetween size="s">
          <ErrorText>{error}</ErrorText>
          <Button
            onClick={() => {
              navigate(hrefSpace(spaceId));
            }}
          >
            {t.page.backToSpace}
          </Button>
        </SpaceBetween>
      </Container>
    </ContentLayout>
  );
}

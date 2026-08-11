import { useEffect, useState } from 'react';
import { api } from 'aws-blocks';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Icon from '@cloudscape-design/components/icon';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useDateTimeFormat, useT } from '@/lib/i18n';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import { sortSiblings } from '@/features/pages/utils/sort';
import { useAsync } from '@/hooks/use-async';
import type { FolderDetail, NodeKind, Page } from '@/types/api';
import { noteFreshness } from '@/features/pages/api/page-cache';
import { hrefHome, hrefNode, hrefSpace, navigate } from '@/lib/router';

/**
 * One folder: its breadcrumb, what it holds, and the way to put something new
 * in it.
 *
 * There is no body and no editor, because a folder has neither — it carries a
 * name, a parent, and a place among its siblings, and nothing else. A reader who
 * wants prose about what a folder gathers writes a page inside it.
 *
 * Renaming and deleting are not here, for the same reason they are not on the
 * page screen: they act on the node's place in the space, so they belong to the
 * tree row that shows that place. Creating *is* here, because an open
 * folder is the most direct answer to "where does this new page go" — but the
 * input it opens is the tree's own, aimed at this folder. One implementation,
 * two ways in.
 */
export function FolderView({
  spaceId,
  spaceName,
  folderId,
  editable,
  onCreate,
  onBreadcrumb,
}: {
  spaceId: string;
  spaceName: string;
  folderId: string;
  editable: boolean;
  /** Opens the tree's title input inside this folder. */
  onCreate: (kind: NodeKind) => void;
  /** Reports which space the path was read in, so a stale one is not applied elsewhere. */
  onBreadcrumb: (spaceId: string, ancestorIds: string[]) => void;
}) {
  const t = useT();
  const { data: folder, error, loading } = useAsync<FolderDetail>(
    () => api.getFolder(folderId),
    [folderId],
  );

  useEffect(() => {
    if (folder) onBreadcrumb(spaceId, folder.breadcrumb.map((step) => step.pageId));
  }, [folder, spaceId, onBreadcrumb]);

  if (loading) return <Loading label={t.page.loadingFolder} />;
  if (error !== null) return <FolderUnavailable spaceId={spaceId} error={error} />;
  if (folder === null) return null;

  const title = folder.title || t.page.untitled;

  return (
    <ContentLayout
      breadcrumbs={
        <BreadcrumbGroup
          ariaLabel={t.page.breadcrumbAria}
          items={[
            { text: t.page.spacesRoot, href: hrefHome() },
            { text: spaceName, href: hrefSpace(spaceId) },
            // Every step carries its own kind, so an ancestor is linked at the
            // screen that can answer for it. Before the folder migration has run
            // an ancestor may still be a page.
            ...folder.breadcrumb.map((step) => ({
              text: step.title || t.page.untitled,
              href: hrefNode(spaceId, step.pageId, step.kind),
            })),
            { text: title, href: hrefNode(spaceId, folderId, 'folder') },
          ]}
          onFollow={(e) => {
            e.preventDefault();
            navigate(e.detail.href);
          }}
        />
      }
      header={
        <Header
          variant="h1"
          description={t.common.kind.folder}
          actions={
            editable ? (
              <ButtonDropdown
                variant="primary"
                items={[
                  { id: 'page', text: t.page.createPage },
                  { id: 'folder', text: t.page.createFolder },
                ]}
                onItemClick={({ detail }) => onCreate(detail.id === 'folder' ? 'folder' : 'page')}
              >
                {t.page.addHere}
              </ButtonDropdown>
            ) : undefined
          }
        >
          {title}
        </Header>
      }
    >
      <FolderContents spaceId={spaceId} folderId={folderId} />
    </ContentLayout>
  );
}

/**
 * What the folder holds, in the order the tree shows it.
 *
 * The same call the tree makes, paged the same way: `listChildPages` answers for
 * both kinds at once because they share one partition and one sort order,
 * so the listing needs no merging.
 *
 * The rows are then put in the screen's own order — folders first, then pages,
 * each by name — which is why the sort happens at render and not
 * where a page of results is stored: a second page appends to the first, and
 * the whole level is ordered again.
 */
function FolderContents({ spaceId, folderId }: { spaceId: string; folderId: string }) {
  const t = useT();
  const dateTime = useDateTimeFormat();
  const [items, setItems] = useState<Page[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Written out rather than run through `useAsync`, because a second page is
  // appended to the first rather than replacing it.
  useEffect(() => {
    let live = true;
    setItems([]);
    setCursor(null);
    setError(null);
    setLoading(true);
    api
      .listChildPages(spaceId, folderId)
      .then((result) => {
        if (!live) return;
        // The rows carry revisions and update times, and recording them is what
        // lets a page opened from here render its held body with no request
        // — the same bargain the tree strikes.
        noteFreshness(result.items);
        setItems(result.items);
        setCursor(result.nextCursor);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(errMessage(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [spaceId, folderId]);

  const loadMore = (from: string) => {
    setLoading(true);
    api
      .listChildPages(spaceId, folderId, from)
      .then((result) => {
        noteFreshness(result.items);
        setItems((prev) => [...prev, ...result.items]);
        setCursor(result.nextCursor);
        setLoading(false);
      })
      .catch((e) => {
        setError(errMessage(e));
        setLoading(false);
      });
  };

  if (error !== null) return <ErrorText>{error}</ErrorText>;

  return (
    <SpaceBetween size="s">
      <Table
        variant="container"
        items={sortSiblings(items)}
        loading={loading && items.length === 0}
        loadingText={t.common.loading}
        trackBy={(item) => item.pageId}
        columnDefinitions={[
          {
            id: 'title',
            header: t.page.columnName,
            cell: (item) => <NodeLink spaceId={spaceId} node={item} />,
          },
          {
            id: 'updatedAt',
            header: t.page.columnUpdatedAt,
            cell: (item) => (item.updatedAt ? dateTime(item.updatedAt) : t.common.empty),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.page.emptyFolder}
          </Box>
        }
      />
      {cursor !== null && (
        <Link variant="primary" onFollow={() => loadMore(cursor)}>
          {t.page.loadMore}
        </Link>
      )}
    </SpaceBetween>
  );
}

function NodeLink({ spaceId, node }: { spaceId: string; node: Page }) {
  const t = useT();
  const href = hrefNode(spaceId, node.pageId, node.kind);
  return (
    <SpaceBetween size="xs" direction="horizontal">
      <Icon name={node.kind === 'folder' ? 'folder' : 'file'} />
      <Link
        href={href}
        onFollow={(e) => {
          e.preventDefault();
          navigate(href);
        }}
      >
        {node.title || t.page.untitled}
      </Link>
    </SpaceBetween>
  );
}

/**
 * What a folder route shows when the folder cannot be read — deleted from the
 * tree while it was open, or a permission that changed. The reason belongs on
 * screen unedited, with a route out.
 */
function FolderUnavailable({ spaceId, error }: { spaceId: string; error: string }) {
  const t = useT();
  return (
    <ContentLayout header={<Header variant="h1">{t.page.folderUnavailable}</Header>}>
      <SpaceBetween size="s">
        <ErrorText>{error}</ErrorText>
        <Link
          href={hrefSpace(spaceId)}
          onFollow={(e) => {
            e.preventDefault();
            navigate(hrefSpace(spaceId));
          }}
        >
          {t.page.backToSpace}
        </Link>
      </SpaceBetween>
    </ContentLayout>
  );
}

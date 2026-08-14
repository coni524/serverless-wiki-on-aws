import { useEffect, useState } from 'react';
import { api } from 'aws-blocks';
import { useQuery } from '@tanstack/react-query';
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
import type { NodeKind, Page } from '@/types/api';
import { folderKey, loadMoreTreeLevel, treeLevelQuery } from '@/features/pages/api/page-cache';
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
  // Through the query cache rather than a fetch of its own, so that a rename
  // made in the tree row relabels this heading in the same frame: the tree
  // writes the new title into this entry (`noteRenamedNode`).
  const {
    data: folder,
    error,
    isPending,
  } = useQuery({ queryKey: folderKey(folderId), queryFn: () => api.getFolder(folderId) });

  useEffect(() => {
    if (folder) onBreadcrumb(spaceId, folder.breadcrumb.map((step) => step.pageId));
  }, [folder, spaceId, onBreadcrumb]);

  if (error) return <FolderUnavailable spaceId={spaceId} error={errMessage(error)} />;
  if (isPending) return <Loading label={t.page.loadingFolder} />;
  if (folder === undefined) return null;

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
 * Not merely the same call the tree makes — the same query. One entry in the
 * cache holds the level, whichever of the two fetched it, so a node deleted
 * from the tree row leaves this table at the same moment and neither screen
 * reloads to find out. `listChildPages` answers for both kinds at once because
 * they share one partition and one sort order, so the listing needs no merging.
 *
 * The rows are then put in the screen's own order — folders first, then pages,
 * each by name — which is why the sort happens at render and not
 * where a page of results is stored: a second page appends to the first, and
 * the whole level is ordered again.
 */
function FolderContents({ spaceId, folderId }: { spaceId: string; folderId: string }) {
  const t = useT();
  const dateTime = useDateTimeFormat();
  const { data: level, error, isPending } = useQuery(treeLevelQuery(spaceId, folderId));
  // The continuation runs outside the query, as it does in the tree, so its
  // failure is reported on its own rather than replacing the rows already read.
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const items = level?.items ?? [];
  const cursor = level?.cursor ?? null;

  const loadMore = (from: string) => {
    setLoadingMore(true);
    setMoreError(null);
    loadMoreTreeLevel(spaceId, folderId, from)
      .catch((e: unknown) => setMoreError(errMessage(e)))
      .finally(() => setLoadingMore(false));
  };

  if (error) return <ErrorText>{errMessage(error)}</ErrorText>;

  return (
    <SpaceBetween size="s">
      <Table
        variant="container"
        items={sortSiblings(items)}
        loading={isPending || loadingMore}
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
      {moreError !== null && <ErrorText>{moreError}</ErrorText>}
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

import { api } from 'aws-blocks';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { useT } from '../i18n';
import { ErrorText, Loading, canWrite, useAsync, type NodeKind } from '../lib';
import { hrefHome, hrefSpace, navigate } from '../router';
import { FolderView } from './FolderView';
import { PageView } from './PageView';

/**
 * A space's content area: the space's own landing panel, the selected page, or
 * the selected folder. The page tree that goes with it is the shell's navigation
 * panel, which is why the tree's state is held there and not here.
 */
export function SpaceView({
  spaceId,
  node,
  onCreate,
  onStructureChange,
  onBreadcrumb,
}: {
  spaceId: string;
  /** What the route selected inside the space, or `null` for the space itself. */
  node: { kind: NodeKind; id: string } | null;
  /** Opens the tree's title input inside the open folder. */
  onCreate: (parentPageId: string, kind: NodeKind) => void;
  onStructureChange: () => void;
  onBreadcrumb: (spaceId: string, ancestorIds: string[]) => void;
}) {
  const t = useT();
  const { data: space, error, loading } = useAsync(() => api.getSpace(spaceId), [spaceId]);

  if (loading) return <Loading label={t.space.loadingSpace} />;
  if (error !== null) return <ErrorText>{error}</ErrorText>;
  if (space === null) return null;

  const editable = canWrite(space.permission);

  if (node !== null && node.kind === 'folder') {
    return (
      <FolderView
        key={node.id}
        spaceId={spaceId}
        spaceName={space.name}
        folderId={node.id}
        editable={editable}
        onCreate={(kind) => onCreate(node.id, kind)}
        onBreadcrumb={onBreadcrumb}
      />
    );
  }

  if (node !== null) {
    return (
      <PageView
        key={node.id}
        spaceId={spaceId}
        spaceName={space.name}
        pageId={node.id}
        editable={editable}
        onStructureChange={onStructureChange}
        onBreadcrumb={onBreadcrumb}
      />
    );
  }

  return (
    <ContentLayout
      breadcrumbs={
        <BreadcrumbGroup
          ariaLabel={t.space.breadcrumbLabel}
          items={[
            { text: t.space.allSpaces, href: hrefHome() },
            { text: space.name, href: hrefSpace(spaceId) },
          ]}
          onFollow={(e) => {
            e.preventDefault();
            navigate(e.detail.href);
          }}
        />
      }
      header={
        <Header variant="h1" actions={<Badge>{space.permission}</Badge>}>
          {space.name}
        </Header>
      }
    >
      <Container>
        {space.description !== '' ? (
          <Box>{space.description}</Box>
        ) : (
          <Box color="text-status-inactive">{t.space.noDescription}</Box>
        )}
        <Box color="text-status-inactive" padding={{ top: 's' }}>
          {t.space.pickFromTree(editable)}
        </Box>
      </Container>
    </ContentLayout>
  );
}

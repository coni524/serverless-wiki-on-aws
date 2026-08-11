import type { CSSProperties } from 'react';
import { api } from 'aws-blocks';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Drawer from '@cloudscape-design/components/drawer';
import { colorBorderDividerDefault } from '@cloudscape-design/design-tokens';
import { useT } from '@/lib/i18n';
import { canWrite } from '@/features/spaces/utils/permissions';
import { useAsync } from '@/hooks/use-async';
import type { NodeKind, Space } from '@/types/api';
import { hrefHome, hrefSpace, navigate } from '@/lib/router';
import { PageTree, type NewNodeTarget } from '@/features/pages/components/PageTree';

/** The switcher's last entry, which is not a space but the screen listing them. */
const ALL_SPACES = '#all-spaces';

/**
 * Above this many spaces the switcher opens with a filter box. Below it the
 * whole list is taken in at a glance, and a search row would be one more thing
 * to skip past on the way to a name that is already on screen.
 */
const FILTER_FROM = 8;

/**
 * The left panel of a space: which space is open, its page tree, and the control
 * that starts a page or a folder at the space root.
 *
 * The panel asks for `mySpaces` rather than this one space, and the header is
 * why: the switcher needs every space the reader can reach, and that listing
 * carries the permission held on each, so the current space's name
 * and the reader's write permission come out of the same request. It is one
 * request either way — `getSpace` is what it replaces.
 *
 * The title input opens inside the tree, so which row it belongs to is state
 * the shell holds — the header's plus aims it at the root, a row's plus aims it
 * at that row, and the folder screen's buttons aim it at the folder they are
 * showing. It is the shell's rather than this panel's because that third caller
 * is in the content area, not in here.
 *
 * The header is this component's own row rather than the `Drawer`'s `header`
 * slot, because the row has a third control in it that belongs to nobody here:
 * `AppLayout` pins its collapse button 15px below the top of the panel. The
 * drawer's header keeps that corner clear but sets its own vertical padding, so
 * its title and the collapse button sit on two different centre lines. This row
 * takes the same 15px, and every control in it — the switcher, the plus, and
 * `AppLayout`'s button — is a Cloudscape button of one height, so all three
 * share a centre. Reserving the corner is then this row's job too, which is what
 * its end padding is for.
 *
 * `disableContentPaddings` turns off the drawer's own 28px inset so the header
 * and the tree can set their own, much smaller ones (`.wiki-nav-header` and
 * `.wiki-page-tree` in styles.css). The drawer's inset is sized for a panel of
 * prose; this panel holds a tree whose every level is indented again, and paying
 * 28px before the first level starts costs the deepest titles the width they
 * need.
 */
export function SpaceNavigation({
  spaceId,
  currentPageId,
  expandPath,
  newNode,
  onNewNode,
  onNewNodeEnd,
  onCreated,
  onChanged,
}: {
  spaceId: string;
  currentPageId: string | null;
  expandPath: string[];
  /** Where the open title input sits, or `null` when nothing is being created. */
  newNode: NewNodeTarget | null;
  onNewNode: (target: NewNodeTarget) => void;
  onNewNodeEnd: () => void;
  onCreated: (nodeId: string, kind: NodeKind) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { data: spaces } = useAsync(() => api.mySpaces(), []);
  const current = spaces?.find((space) => space.spaceId === spaceId) ?? null;

  const editable = current !== null && canWrite(current.permission);

  return (
    <Drawer disableContentPaddings>
      <div
        className="wiki-nav-header"
        style={{ '--wiki-nav-header-border': colorBorderDividerDefault } as CSSProperties}
      >
        <SpaceSwitcher spaces={spaces} current={current} />
        {editable && (
          <ButtonDropdown
            variant="icon"
            iconName="add-plus"
            ariaLabel={t.space.addToSpaceRoot}
            expandToViewport
            items={[
              { id: 'page', text: t.space.createPage },
              { id: 'folder', text: t.space.createFolder },
            ]}
            onItemClick={({ detail }) =>
              onNewNode({
                parentPageId: null,
                kind: detail.id === 'folder' ? 'folder' : 'page',
              })
            }
          />
        )}
      </div>

      <PageTree
        spaceId={spaceId}
        currentPageId={currentPageId}
        expandPath={expandPath}
        editable={editable}
        newNode={newNode}
        onNewNode={onNewNode}
        onNewNodeEnd={onNewNodeEnd}
        onCreated={onCreated}
        onChanged={onChanged}
      />
    </Drawer>
  );
}

/**
 * The panel's title, as the control that changes it: the open space's name, and
 * a menu of every space the reader can read.
 *
 * A heading here would only repeat what the breadcrumb above the content already
 * says. Leaving a space meant going back to the space list and coming in again,
 * which is the one move this panel can save — so the name is a button, and the
 * spaces sit under it in the order the list screen uses (`mySpaces` sorts by
 * name).
 *
 * Every entry carries an `href`, so a space can be opened in a new tab from the
 * menu the same as from a link. `onItemFollow` is where the click is taken over
 * for the router; without the `href` the entries would be dead to the middle
 * button.
 *
 * The name is `null` for as long as the request is in flight, and the button
 * shows the generic space label until it lands. It is not disabled while it
 * waits: the entry it needs least is the one for the space already open.
 */
function SpaceSwitcher({ spaces, current }: { spaces: Space[] | null; current: Space | null }) {
  const t = useT();
  // Name only. A space's description belongs to the screen that lists them,
  // where there is width for it; here it would push the names apart in a panel
  // whose width the reader has already chosen.
  const items = (spaces ?? []).map((space) => ({
    id: space.spaceId,
    text: space.name,
    href: hrefSpace(space.spaceId),
  }));

  return (
    <ButtonDropdown
      ariaLabel={t.space.switchSpace}
      expandToViewport
      loading={spaces === null}
      loadingText={t.common.loading}
      filteringType={items.length >= FILTER_FROM ? 'auto' : 'none'}
      filteringPlaceholder={t.space.searchSpaces}
      filteringAriaLabel={t.space.searchSpaces}
      items={[...items, { id: ALL_SPACES, text: t.space.allSpaces, href: hrefHome() }]}
      onItemFollow={(e) => {
        e.preventDefault();
        if (e.detail.href !== undefined) navigate(e.detail.href);
      }}
    >
      {current?.name ?? t.space.spaceFallback}
    </ButtonDropdown>
  );
}

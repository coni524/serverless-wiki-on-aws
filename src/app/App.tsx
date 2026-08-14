import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { api, authApi } from 'aws-blocks';
import { Authenticator, broadcastAuthChange, onAuthChange } from '@aws-blocks/blocks/ui';
import AppLayout from '@cloudscape-design/components/app-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TopNavigation, {
  type TopNavigationProps,
} from '@cloudscape-design/components/top-navigation';
import Link from '@cloudscape-design/components/link';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import type { Me, NodeKind } from '@/types/api';
import { useMe } from '@/features/auth/api/identity';
import { clearAttachmentCache } from '@/features/pages/api/attachment-cache';
import { dropServerState, resetServerState } from '@/features/pages/api/page-cache';
import { LOCALES, LOCALE_NAMES, useLocale, useT, type Locale } from '@/lib/i18n';
import { hrefAdmin, hrefHome, hrefNode, navigate, useRoute } from '@/lib/router';
import { AdminNavigation } from '@/features/admin/components/AdminNavigation';
import { authenticatorOptions, watchTypedUsername } from '@/features/auth/components/totp-setup';
import { ASSISTANT_DRAWER_ID, AiAssistant, useAssistant } from '@/features/assistant/components/AiAssistant';
import {
  NavigationResizer,
  readStoredNavigationWidth,
  storeNavigationWidth,
} from '@/components/NavigationResizer';
import { PendingChange } from '@/app/PendingChange';
import { SearchBox } from '@/features/search/components/SearchBox';
import { SpaceNavigation } from '@/app/SpaceNavigation';
import type { NewNodeTarget } from '@/features/pages/components/PageTree';
import { SearchView } from '@/app/routes/SearchView';
import { SpaceList } from '@/app/routes/SpaceList';
import { SpaceView } from '@/app/routes/SpaceView';
import { AdminView } from '@/app/routes/admin/AdminView';

/**
 * The application shell.
 *
 * Cloudscape's `AppLayout` owns the frame: the page tree is its navigation
 * panel, the AI assistant is a resizable drawer on the right, and the routed
 * view is the content. `headerSelector` tells the layout how tall the top
 * navigation is, so the panels stop below it instead of sliding underneath.
 *
 * The tree lives beside the content rather than inside it, so the state the two
 * share is held here: `expandPath` (the current page's ancestors, reported by
 * the page view) keeps the selected page unfolded, and what a write changed
 * travels through the query cache rather than through props. Only the space is
 * on the tree's `key`, because only the space makes it a different tree.
 */
export function App() {
  const t = useT();
  // Three states, not two: `undefined` is "the shell has not been told yet",
  // and it is what keeps the sign-in screen off the page while the answer is
  // still in flight. Collapsing it into `null` is what made a reload flash
  // the sign-in prompt at a user who was signed in the whole time.
  const [user, setUser] = useState<{ username: string } | null | undefined>(undefined);
  const route = useRoute();

  // The open page's ancestors, and the space they were read in. The space is
  // carried with them because the path outlives the route that produced it: the
  // page view reports its breadcrumb once its fetch lands, so for the first
  // moments in a new space the last path still stands, and applied there it
  // would ask that tree to unfold pages that are not in it.
  const [breadcrumb, setBreadcrumb] = useState<{ spaceId: string; ancestorIds: string[] } | null>(
    null,
  );
  const [navigationOpen, setNavigationOpen] = useState(true);
  // Where the tree's title input is open, and for which kind. Held
  // here rather than in the navigation panel because two screens aim it: the
  // panel's own plus and a row's plus, and the buttons on an open folder.
  const [newNode, setNewNode] = useState<NewNodeTarget | null>(null);
  // The panel's width is the reader's to set and the browser's to remember, so
  // it is read from storage once and written back when a drag ends.
  const [navigationWidth, setNavigationWidth] = useState(readStoredNavigationWidth);
  const [activeDrawerId, setActiveDrawerId] = useState<string | null>(null);

  // Stable on purpose: the page view reports from an effect that lists this
  // callback among its dependencies, so a new function each render would report,
  // re-render, and report again without end.
  const onBreadcrumb = useCallback(
    (spaceId: string, ancestorIds: string[]) => setBreadcrumb({ spaceId, ancestorIds }),
    [],
  );

  // Who the caches below hold data for. `undefined` until the first answer
  // lands, so settling the initial frame is not mistaken for a change of user.
  const cachedFor = useRef<string | null | undefined>(undefined);

  /**
   * Settle who the user is, then follow them.
   *
   * The shell asks the auth block for the session itself instead of taking the
   * first thing `onAuthChange` hands it. The block keeps the session in a
   * module-level cache and calls a new subscriber back synchronously with
   * whatever that cache holds; on a reload the cache is empty, so the first
   * call says `null` — not "signed out", but "not asked yet". The real answer
   * is a request away, and the block will not say `null` a second time when
   * the request agrees with the guess, so a subscriber cannot tell the two
   * apart on its own.
   *
   * So `getAuthState()` decides the first frame, and every emission before it
   * lands is dropped. A failed request settles on signed out: the sign-in form
   * is the one screen that can still lead somewhere when the API is unreachable.
   * After that the subscription is what it is for — the sign-in form's own
   * success, and a sign-out in another tab.
   */
  useEffect(() => {
    let live = true;
    let settled = false;
    const apply = (next: { username: string } | null) => {
      if (!live) return;
      // A change of identity empties both caches, and it is not enough that
      // signing out in *this* tab reloads. Another tab's sign-out reaches this
      // one through the auth channel, which re-renders to the sign-in form
      // without reloading — the held bodies survive it, and the next user to
      // sign in here lands on the same route, where the page view shows a held
      // body on the first frame before the server can refuse it.
      const who = next?.username ?? null;
      if (cachedFor.current !== undefined && cachedFor.current !== who) {
        void dropServerState();
        void clearAttachmentCache();
      }
      cachedFor.current = who;
      setUser(next);
    };

    void authApi
      .getAuthState()
      .then((state) => {
        settled = true;
        apply(state.user ? { username: state.user.username } : null);
      })
      .catch(() => {
        settled = true;
        apply(null);
      });

    const unsubscribe = onAuthChange(authApi, (next) => {
      if (!settled) return;
      apply(next ? { username: next.username } : null);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const authKnown = user !== undefined;
  const signedIn = user != null;
  const spaceId =
    route.name === 'space' || route.name === 'page' || route.name === 'folder'
      ? route.spaceId
      : null;
  // What the route selected inside the space. Both kinds are nodes of one
  // tree, so everything below this line treats them alike; only the view
  // that draws them tells them apart.
  const node: { kind: NodeKind; id: string } | null =
    route.name === 'page'
      ? { kind: 'page', id: route.pageId }
      : route.name === 'folder'
        ? { kind: 'folder', id: route.folderId }
        : null;
  const nodeId = node?.id ?? null;
  // What the tree unfolds: the open node's ancestors, plus the node itself so
  // its own children show. A path read in another space is dropped rather than
  // handed on.
  const ancestorIds = breadcrumb !== null && breadcrumb.spaceId === spaceId
    ? breadcrumb.ancestorIds
    : [];
  const expandPath = nodeId !== null ? [...ancestorIds, nodeId] : ancestorIds;

  // A title input opened in one space has no row to sit on in the next.
  useEffect(() => {
    setNewNode(null);
  }, [spaceId]);

  /**
   * Start a create from the folder screen, in the tree.
   *
   * The input belongs to the tree either way — one implementation of "type a
   * name where the node will live" (`PageTree`). What the content area adds is
   * the way in, so a folder that is already open does not send the reader back
   * to the panel to find its row. A collapsed panel is opened first, or the
   * input would be typed into a row nobody can see.
   */
  const startCreate = useCallback((parentPageId: string, kind: NodeKind) => {
    setNewNode({ parentPageId, kind });
    setNavigationOpen(true);
  }, []);

  // Held here, not in the drawer: a closed drawer unmounts its contents, and a
  // conversation must survive being dismissed (see `useAssistant`). The route is
  // read here too, so this is also where the assistant learns which page the
  // user is looking at — the one thing it cannot work out for itself.
  const assistant = useAssistant({
    // The one caller of the blunt instrument. The assistant's writes land on
    // the server with only the chunk stream to say what they touched, so
    // nothing here knows which page the model created, renamed, or deleted —
    // and nothing here can apply the change the way the tree does for its own
    // edits (`noteDeletedNode` and the rest). Every node is read again; the
    // shell around them is left alone.
    onWriteApplied: resetServerState,
    // Only a page is reported. The assistant's screen claim resolves to a page
    // it can read and quote; a folder has no body to be looking at.
    viewing: { spaceId, pageId: node?.kind === 'page' ? node.id : null },
  });
  // The management screens put their section list in the same panel the page
  // tree uses; only one of the two is ever on screen.
  const adminSection = route.name === 'admin' ? route.section : null;
  // No panel, no edge to drag: the home screen and the signed-out screen have
  // no tree, and a collapsed panel has no width to set.
  const navigationShown = signedIn && (spaceId !== null || adminSection !== null);

  // Fetched here rather than in the routed view because the account menu needs
  // it too. The auth block's `username` is not a display value: with sign-in by
  // email address the pool generates it, so on the real pool it is the Cognito
  // `sub`. The address the user typed comes from `me()`.
  const identity = useMe(signedIn);

  const signOut = useCallback(async () => {
    // The sign-out itself is still the auth block's own state machine — only
    // the menu that triggers it is ours. The block broadcasts from its own UI,
    // so this path has to announce the change or the shell keeps the stale user.
    await authApi.setAuthState({ action: 'signOut' });
    broadcastAuthChange(null);
    // Then start the page over from the home route.
    //
    // The block keeps its own copy of the auth state in a module-level cache,
    // and nothing it exports refreshes that copy: `broadcastAuthChange` reaches
    // subscribers — this shell among them — while the cache is only written by
    // the block's own form, and its cross-tab channel does not deliver to the
    // tab that posted. Left alone, the sign-in form mounted by the very next
    // frame reads the stale copy and greets the user who just signed out, with
    // a "Sign Out" button as its only control. Reloading is what clears it.
    //
    // It also drops the conversation, the tree and the open page, which is
    // what signing out should do to them in any case.
    //
    // The cached attachment bytes and the persisted page bodies are the two
    // things a reload does not take with it, so both are dropped explicitly and
    // before it. Both deletions are awaited: a reload can cut an IndexedDB
    // transaction short, and what it leaves behind is exactly what these two
    // lines exist to remove. (`dropServerState` also runs from the auth
    // subscription when the broadcast above lands; running it twice is
    // harmless.)
    await dropServerState();
    await clearAttachmentCache();
    navigate(hrefHome());
    window.location.reload();
  }, []);

  return (
    <>
      <TopBar
        signedIn={signedIn}
        email={identity.data?.email ?? null}
        isGlobalAdmin={identity.data?.isGlobalAdmin === true}
        onSignOut={signOut}
      />

      {navigationShown && navigationOpen && (
        <NavigationResizer
          width={navigationWidth}
          onChange={setNavigationWidth}
          onCommit={storeNavigationWidth}
        />
      )}

      <AppLayout
        headerSelector="#top-navigation"
        toolsHide
        navigationHide={!navigationShown}
        navigationOpen={navigationOpen}
        navigationWidth={navigationWidth}
        onNavigationChange={(e) => setNavigationOpen(e.detail.open)}
        navigation={
          adminSection !== null ? (
            <AdminNavigation section={adminSection} />
          ) : spaceId !== null ? (
            <SpaceNavigation
              key={spaceId}
              spaceId={spaceId}
              currentPageId={nodeId}
              expandPath={expandPath}
              newNode={newNode}
              onNewNode={setNewNode}
              onNewNodeEnd={() => setNewNode(null)}
              onCreated={(createdId, kind) => navigate(hrefNode(spaceId, createdId, kind))}
            />
          ) : undefined
        }
        drawers={
          signedIn
            ? [
                {
                  id: ASSISTANT_DRAWER_ID,
                  ariaLabels: {
                    drawerName: t.app.assistantDrawer,
                    closeButton: t.common.close,
                    triggerButton: t.app.assistantDrawer,
                    resizeHandle: t.app.resizeAssistant,
                  },
                  trigger: { iconName: 'gen-ai' },
                  resizable: true,
                  defaultSize: 420,
                  content: <AiAssistant {...assistant} />,
                },
              ]
            : []
        }
        activeDrawerId={activeDrawerId}
        onDrawerChange={(e) => setActiveDrawerId(e.detail.activeDrawerId)}
        content={
          !authKnown ? (
            <Loading label={t.app.checkingSession} />
          ) : !signedIn ? (
            <SignIn />
          ) : (
            <>
              {/* A pending write takes over the content area while it waits. It
                  is a decision the user has to make before anything else on the
                  screen means what it says — the page in front of them is about
                  to change — and showing the change rather than the tool's
                  arguments needs the width.

                  The view underneath is hidden, not unmounted: someone halfway
                  through writing a page can ask the assistant for something,
                  and unmounting the editor to make room for the question would
                  throw away the text they had typed. */}
              {assistant.interrupts.length > 0 && (
                <PendingChange interrupts={assistant.interrupts} />
              )}
              <div hidden={assistant.interrupts.length > 0}>
                <SignedIn
                  me={identity.data}
                  error={identity.error === null ? null : errMessage(identity.error)}
                  loading={identity.isPending}
                  route={route}
                  onCreate={startCreate}
                  onBreadcrumb={onBreadcrumb}
                />
              </div>
            </>
          )
        }
      />
    </>
  );
}

/**
 * The bar above the layout: the product name, the search box, and the account
 * menu.
 *
 * Memoised on purpose. The shell re-renders on every chunk the assistant
 * streams, and `TopNavigation` measures itself in an effect keyed on the props
 * it was given — handed a freshly built `utilities` array each time, it
 * re-measures, re-renders, and re-measures until React stops it with "maximum
 * update depth exceeded". Taking primitives and a stable callback keeps the bar
 * out of that loop entirely. The search box still follows the route, because it
 * reads the route itself.
 *
 * `email` arrives a moment after `signedIn` does, since it comes from a call the
 * shell makes. The menu is shown as soon as the user is known — icon only until
 * the address lands — because the alternative is a menu that appears late and a
 * user who cannot sign out until it does.
 *
 * The language and its dictionary are read from context rather than taken as
 * props, which keeps the memo boundary as narrow as it was: both change only
 * when the reader picks a different language, and that is a moment the bar has
 * to redraw anyway.
 */
const TopBar = memo(function TopBar({
  signedIn,
  email,
  isGlobalAdmin,
  onSignOut,
}: {
  signedIn: boolean;
  email: string | null;
  isGlobalAdmin: boolean;
  onSignOut: () => void;
}) {
  const t = useT();
  const { locale, setLocale } = useLocale();

  // Typed up front rather than inline, so the icon names and the click
  // handlers are checked against the utility they belong to instead of
  // widening to `string` on the way into the array.
  const language: TopNavigationProps.Utility = {
    // Offered signed out as well. The sign-in screen is the first thing a
    // reader sees, and a switcher only the signed-in half of the app has would
    // leave them reading a language they did not choose to get in. Each
    // language is named in itself, so the entry a reader is looking for reads
    // the same whichever language is on.
    type: 'menu-dropdown',
    iconName: 'globe',
    ariaLabel: t.app.language,
    items: LOCALES.map((code) => ({
      id: code,
      text: LOCALE_NAMES[code],
      iconName: code === locale ? 'check' : undefined,
    })),
    onItemClick: (e) => setLocale(e.detail.id as Locale),
  };

  const account: TopNavigationProps.Utility = {
    type: 'menu-dropdown',
    text: email ?? undefined,
    iconName: 'user-profile',
    // The only way into the management screens. They are shown to the
    // administrators who have them; a link everyone can see and nobody else
    // can use is worse than no link.
    items: [
      ...(isGlobalAdmin ? [{ id: 'admin', text: t.app.admin }] : []),
      { id: 'signOut', text: t.app.signOut },
    ],
    onItemClick: (e) => {
      if (e.detail.id === 'admin') navigate(hrefAdmin('users'));
      else void onSignOut();
    },
  };

  return (
    <div id="top-navigation">
      <TopNavigation
        identity={{
          href: hrefHome(),
          title: 'sl-wiki',
          onFollow: (e) => {
            e.preventDefault();
            navigate(hrefHome());
          },
        }}
        search={signedIn ? <SearchBox /> : undefined}
        utilities={signedIn ? [language, account] : [language]}
      />
    </div>
  );
});

/** Waits for the signed-in identity the shell is loading, then routes. */
function SignedIn({
  me,
  error,
  loading,
  route,
  onCreate,
  onBreadcrumb,
}: {
  me: Me | undefined;
  error: string | null;
  loading: boolean;
  route: ReturnType<typeof useRoute>;
  onCreate: (parentPageId: string, kind: NodeKind) => void;
  onBreadcrumb: (spaceId: string, ancestorIds: string[]) => void;
}) {
  const t = useT();
  if (loading) return <Loading label={t.app.loadingUser} />;
  if (error !== null) return <ErrorText>{t.app.identityFailed(error)}</ErrorText>;
  if (me === undefined) return null;

  switch (route.name) {
    case 'home':
      return <SpaceList me={me} />;
    case 'space':
      return (
        <SpaceView
          spaceId={route.spaceId}
          node={null}
          onCreate={onCreate}
          onBreadcrumb={onBreadcrumb}
        />
      );
    case 'page':
      return (
        <SpaceView
          spaceId={route.spaceId}
          node={{ kind: 'page', id: route.pageId }}
          onCreate={onCreate}
          onBreadcrumb={onBreadcrumb}
        />
      );
    case 'folder':
      return (
        <SpaceView
          spaceId={route.spaceId}
          node={{ kind: 'folder', id: route.folderId }}
          onCreate={onCreate}
          onBreadcrumb={onBreadcrumb}
        />
      );
    case 'pageById':
      return <ResolveNode nodeId={route.pageId} />;
    case 'search':
      return <SearchView query={route.query} spaceId={route.spaceId} />;
    case 'admin':
      return <AdminView me={me} section={route.section} id={route.id} />;
    default:
      return <NotFound />;
  }
}

/** The signed-out screen: the auth block's own form, framed by the shell. */
function SignIn() {
  const t = useT();
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = formRef.current;
    if (container === null || container.hasChildNodes()) return;
    // The pool requires an authenticator, and the block's own form cannot draw
    // the enrolment step — see `totp-setup.ts`. The options put the QR code and
    // the key into it; the watcher reads the address on its way past, so the
    // authenticator app can label the account with it.
    const unwatch = watchTypedUsername(container);
    container.appendChild(Authenticator(authApi, authenticatorOptions()));
    return unwatch;
  }, []);

  return (
    <ContentLayout header={<Header variant="h1">sl-wiki</Header>}>
      <Container header={<Header variant="h2">{t.app.signInHeading}</Header>}>
        <SpaceBetween size="s">
          <span>{t.app.signInPrompt}</span>
          {/* The block returns DOM nodes, not React elements, so its form is
              mounted by hand. */}
          <div ref={formRef} />
        </SpaceBetween>
      </Container>
    </ContentLayout>
  );
}

/**
 * A shared link carrying only a node id. Resolve its space and its kind, then
 * redirect to the canonical route so the tree has its space context.
 *
 * The kind is not in the link — ids are one namespace across both — so it is
 * settled by asking. `getPage` answers for a page and refuses a folder
 * with the same "not found" it gives an id that names nothing, so a refusal is
 * followed by the folder call before the reader is told the link is dead.
 */
function ResolveNode({ nodeId }: { nodeId: string }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPage(nodeId)
      .then((page) => hrefNode(page.spaceId, nodeId, 'page'))
      .catch(async (pageError: unknown) => {
        try {
          const folder = await api.getFolder(nodeId);
          return hrefNode(folder.spaceId, nodeId, 'folder');
        } catch {
          // The page error is the one reported: it is the more likely of the
          // two, and reporting the second would tell a reader who followed a
          // link to a deleted page that no folder was found.
          throw pageError;
        }
      })
      .then((href) => {
        if (live) navigate(href);
      })
      .catch((e) => {
        if (live) setError(errMessage(e));
      });
  }, [nodeId]);
  if (error) return <ErrorText>{t.app.openPageFailed(error)}</ErrorText>;
  return <Loading label={t.app.openingPage} />;
}

function NotFound() {
  const t = useT();
  return (
    <ContentLayout header={<Header variant="h1">{t.app.notFoundHeading}</Header>}>
      <Container>
        <SpaceBetween size="s">
          <span>{t.app.notFoundBody}</span>
          <Link
            href={hrefHome()}
            onFollow={(e) => {
              e.preventDefault();
              navigate(hrefHome());
            }}
          >
            {t.app.backToSpaces}
          </Link>
        </SpaceBetween>
      </Container>
    </ContentLayout>
  );
}

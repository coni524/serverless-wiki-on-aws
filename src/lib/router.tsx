import { useEffect, useState } from 'react';

/**
 * A tiny hash-based router. Hash routing keeps every route in a single static
 * file, so the SPA works when served straight from S3/CloudFront with no
 * server-side rewrite. Deliberately dependency-free: the
 * route surface is small and swapping in a library later stays local to here.
 */
export type Route =
  | { name: 'home' }
  | { name: 'space'; spaceId: string }
  | { name: 'page'; spaceId: string; pageId: string }
  // A folder. Its own route rather than the page route, because the
  // two screens read different calls: `getPage` refuses a folder outright, so a
  // shared route would have to try one and fall back to the other on a 404.
  | { name: 'folder'; spaceId: string; folderId: string }
  // A shared link that carries only a node id (ids travel without their
  // space). Resolved to the canonical space+page or space+folder route on
  // arrival, which is also where its kind is settled.
  | { name: 'pageById'; pageId: string }
  // Search results. `spaceId` scopes the search to one space; null spans all.
  | { name: 'search'; query: string; spaceId: string | null }
  // The management screens (global administrators only). `section` picks the
  // screen; `id` is the group being looked at, or null for the listing.
  | { name: 'admin'; section: AdminSection; id: string | null }
  | { name: 'notFound' };

/** The four management screens, in the order the side navigation lists them. */
export const ADMIN_SECTIONS = ['users', 'user-groups', 'role-groups', 'defaults'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

const isAdminSection = (value: string): value is AdminSection =>
  (ADMIN_SECTIONS as readonly string[]).includes(value);

/**
 * One path segment, decoded, with a malformed escape read as itself.
 *
 * `decodeURIComponent` throws `URIError` on `%` that begins no escape, and
 * `parse` runs inside `useRoute`'s `useState` initializer — that is, during
 * render, with no error boundary above it. So `#/spaces/%` in a link anyone can
 * send took the whole application down to a blank page, on that visit and on
 * every reload, because the fragment stays in the address bar. An id that was
 * never encoded properly resolves to nothing and lands on "not found", which is
 * the right answer for a link that names no page.
 */
function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const queryString = queryStart === -1 ? '' : raw.slice(queryStart + 1);
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { name: 'home' };
  if (segments[0] === 'search') {
    const params = new URLSearchParams(queryString);
    // `space=` (empty) in a hand-typed or truncated link falls back to the
    // cross-space search rather than erroring on an empty space id.
    return { name: 'search', query: params.get('q') ?? '', spaceId: params.get('space') || null };
  }
  if (segments[0] === 'spaces' && segments[1]) {
    const spaceId = segment(segments[1]);
    if (segments[2] === 'pages' && segments[3]) {
      return { name: 'page', spaceId, pageId: segment(segments[3]) };
    }
    if (segments[2] === 'folders' && segments[3]) {
      return { name: 'folder', spaceId, folderId: segment(segments[3]) };
    }
    return { name: 'space', spaceId };
  }
  if (segments[0] === 'pages' && segments[1]) {
    return { name: 'pageById', pageId: segment(segments[1]) };
  }
  if (segments[0] === 'admin') {
    // A bare `#/admin` lands on the first screen rather than on "not found":
    // it is the address someone types by hand.
    const section = segments[1] ?? ADMIN_SECTIONS[0];
    if (!isAdminSection(section)) return { name: 'notFound' };
    return {
      name: 'admin',
      section,
      id: segments[2] === undefined ? null : segment(segments[2]),
    };
  }
  return { name: 'notFound' };
}

/**
 * The current hash, still percent-encoded. Firefox returns `location.hash`
 * pre-decoded, which would split a search query containing an encoded `&`;
 * `new URL(...)` keeps the encoded form in every browser.
 */
const currentHash = () => new URL(window.location.href).hash;

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(currentHash()));
  useEffect(() => {
    const onChange = () => setRoute(parse(currentHash()));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// ─── Href builders ───────────────────────────────────────────────────────────

export const hrefHome = () => '#/';
export const hrefSpace = (spaceId: string) => `#/spaces/${encodeURIComponent(spaceId)}`;
export const hrefPage = (spaceId: string, pageId: string) =>
  `#/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;
export const hrefFolder = (spaceId: string, folderId: string) =>
  `#/spaces/${encodeURIComponent(spaceId)}/folders/${encodeURIComponent(folderId)}`;
/**
 * The address of a node whose kind is known — every tree row, breadcrumb step,
 * and freshly created node.
 *
 * Callers hold the kind already: every listing carries it, and so does every
 * breadcrumb step. Routing on it here is what keeps a folder from being opened
 * at the page route, where `getPage` would answer "Page not found".
 */
export const hrefNode = (spaceId: string, nodeId: string, kind: 'page' | 'folder') =>
  kind === 'folder' ? hrefFolder(spaceId, nodeId) : hrefPage(spaceId, nodeId);
export const hrefSearch = (query: string, spaceId: string | null) => {
  const params = new URLSearchParams({ q: query });
  if (spaceId !== null) params.set('space', spaceId);
  return `#/search?${params.toString()}`;
};

export const hrefAdmin = (section: AdminSection) => `#/admin/${section}`;
export const hrefAdminUserGroup = (userGroupId: string) =>
  `#/admin/user-groups/${encodeURIComponent(userGroupId)}`;
export const hrefAdminRoleGroup = (roleGroupId: string) =>
  `#/admin/role-groups/${encodeURIComponent(roleGroupId)}`;

/** Navigate imperatively (after a create, delete, or resolve-and-redirect). */
export function navigate(href: string): void {
  window.location.hash = href.replace(/^#/, '');
}

/**
 * The `onFollow` handler for any Cloudscape component that renders an anchor.
 *
 * Every one of them — `Link`, `BreadcrumbGroup`, `SideNavigation` — reports the
 * href in `detail` and lets the handler cancel the browser's own navigation.
 * Cancelling and setting the hash ourselves keeps the SPA from reloading.
 */
export function followRoute(event: {
  preventDefault: () => void;
  detail: { href?: string; external?: boolean };
}): void {
  const href = event.detail.href;
  if (href === undefined || event.detail.external === true) return;
  event.preventDefault();
  navigate(href);
}

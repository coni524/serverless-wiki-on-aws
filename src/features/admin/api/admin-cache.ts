/**
 * What the four management screens read, and what their writes do to it.
 *
 * The permission model is a graph — account → user group → role group → space
 * — and every screen draws one or two of its edges while naming the nodes at
 * both ends. So the same three listings (`listUserGroups`,
 * `listRoleGroups`, `listSpaces`) are read by several screens at once, and they
 * are given one entry each rather than one per screen.
 *
 * A write here is applied the way every other write in the app is: what the
 * caller already knows goes straight in, what only the server can settle is
 * invalidated. Almost everything on these screens is the second kind — the
 * server decides whether a removal is allowed at all (the last administrator, a
 * system group, the group a new account joins), so what a screen holds after a
 * write is what the server says, not what the button meant. Invalidating rather
 * than resetting is the whole gain: the tables stay on screen while the answer
 * is fetched, where they used to blank to a spinner.
 *
 * None of this is persisted to disk; `app/provider.tsx` dehydrates page bodies
 * and nothing else.
 */
import { api } from 'aws-blocks';
import { type QueryKey } from '@tanstack/react-query';
import { queryClient } from '@/lib/react-query';

// ─── What the screens read ───────────────────────────────────────────────────

export const userGroupsKey: QueryKey = ['admin', 'user-groups'];
export const roleGroupsKey: QueryKey = ['admin', 'role-groups'];
export const adminSpacesKey: QueryKey = ['admin', 'spaces'];
export const defaultsKey: QueryKey = ['admin', 'defaults'];

/** The accounts a user group holds. */
export const membersKey = (userGroupId: string): QueryKey => [
  'admin',
  'user-group',
  userGroupId,
  'members',
];

/** The role groups attached to a user group, from the user group's side. */
export const attachedRoleGroupsKey = (userGroupId: string): QueryKey => [
  'admin',
  'user-group',
  userGroupId,
  'role-groups',
];

/** The spaces a role group grants, and at what level. */
export const grantsKey = (roleGroupId: string): QueryKey => [
  'admin',
  'role-group',
  roleGroupId,
  'grants',
];

/** The same attachment edge, read from the role group's side. */
export const attachedUserGroupsKey = (roleGroupId: string): QueryKey => [
  'admin',
  'role-group',
  roleGroupId,
  'user-groups',
];

/**
 * The federated accounts a role group holds directly.
 *
 * No screen writes this edge: a sign-in does, from the identity provider's
 * claims. It is read so that an administrator can see who a mapping actually
 * reached.
 */
export const roleGroupMembersKey = (roleGroupId: string): QueryKey => [
  'admin',
  'role-group',
  roleGroupId,
  'members',
];

/** Accounts known to the Wiki, filtered by the start of the address. */
export const directoryKey = (prefix: string): QueryKey => ['admin', 'directory', prefix];

export const userGroupsQuery = () => ({
  queryKey: userGroupsKey,
  queryFn: () => api.listUserGroups(),
});

export const roleGroupsQuery = () => ({
  queryKey: roleGroupsKey,
  queryFn: () => api.listRoleGroups(),
});

export const adminSpacesQuery = () => ({
  queryKey: adminSpacesKey,
  queryFn: () => api.listSpaces(),
});

export const defaultsQuery = () => ({ queryKey: defaultsKey, queryFn: () => api.getDefaults() });

export const membersQuery = (userGroupId: string) => ({
  queryKey: membersKey(userGroupId),
  queryFn: () => api.listUserGroupMembers(userGroupId),
});

export const attachedRoleGroupsQuery = (userGroupId: string) => ({
  queryKey: attachedRoleGroupsKey(userGroupId),
  queryFn: () => api.listUserGroupRoleGroups(userGroupId),
});

export const grantsQuery = (roleGroupId: string) => ({
  queryKey: grantsKey(roleGroupId),
  queryFn: () => api.listRoleGroupGrants(roleGroupId),
});

export const attachedUserGroupsQuery = (roleGroupId: string) => ({
  queryKey: attachedUserGroupsKey(roleGroupId),
  queryFn: () => api.listRoleGroupUserGroups(roleGroupId),
});

export const roleGroupMembersQuery = (roleGroupId: string) => ({
  queryKey: roleGroupMembersKey(roleGroupId),
  queryFn: () => api.listRoleGroupMembers(roleGroupId),
});

type DirectoryPage = Awaited<ReturnType<typeof api.findUsers>>;

/** The first page of the directory. Later pages are appended by `loadMoreUsers`. */
export const directoryQuery = (prefix: string) => ({
  queryKey: directoryKey(prefix),
  queryFn: () => api.findUsers(prefix === '' ? null : prefix, null),
});

/**
 * Fetch the next page of accounts and append it to what is held.
 *
 * Paging is keyset (`findUsers` settled that contract), and the pages are
 * appended rather than swapped, so the screen grows downward instead of
 * flipping. A refetch of the entry starts over from the first page, which is
 * deliberate for the same reason it is in the page tree: a continuation is a
 * reading position, not state worth defending against a refetch.
 */
export async function loadMoreUsers(prefix: string, cursor: string): Promise<void> {
  const next = await api.findUsers(prefix === '' ? null : prefix, cursor);
  queryClient.setQueryData<DirectoryPage>(directoryKey(prefix), (prev) =>
    prev === undefined ? next : { ...next, users: [...prev.users, ...next.users] },
  );
}

// ─── What a write does to the cache ──────────────────────────────────────────

/**
 * Ask the server again for everything the management screens hold, without
 * emptying any of it. This is what the reload button on each screen does.
 */
export function refreshAdmin(): void {
  void queryClient.invalidateQueries({ queryKey: ['admin'] });
}

/**
 * A user group or a role group was created or deleted.
 *
 * The coarsest of these on purpose, which is why it is the reload button's
 * function under another name: a group's name is drawn by screens that never
 * fetched the group itself — the attachment tables show the name at the far end
 * of the edge, and a deleted one turns into a bare id there. So the whole
 * management surface is asked again, which costs a handful of listings and
 * keeps every table's labels honest.
 */
export function noteGroupsChanged(): void {
  refreshAdmin();
}

/** An account joined or left a user group. */
export function noteMembersChanged(userGroupId: string): void {
  void queryClient.invalidateQueries({ queryKey: membersKey(userGroupId) });
}

/**
 * A role group was attached to a user group, or detached from it.
 *
 * One edge, two screens read it from opposite ends, so both entries are
 * invalidated by whichever screen made the change.
 */
export function noteAttachmentChanged(userGroupId: string, roleGroupId: string): void {
  void queryClient.invalidateQueries({ queryKey: attachedRoleGroupsKey(userGroupId) });
  void queryClient.invalidateQueries({ queryKey: attachedUserGroupsKey(roleGroupId) });
}

/** A space was granted to a role group, re-granted at another level, or revoked. */
export function noteGrantsChanged(roleGroupId: string): void {
  void queryClient.invalidateQueries({ queryKey: grantsKey(roleGroupId) });
}

/**
 * The default user group was set or cleared.
 *
 * Invalidated rather than written in, because the record carries a version the
 * next save has to send and only the server states the new one.
 */
export function noteDefaultsChanged(): void {
  void queryClient.invalidateQueries({ queryKey: defaultsKey });
}

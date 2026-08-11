import { api } from 'aws-blocks';

// Derived straight from the typed API client so the frontend never restates a
// backend shape. If a method's return type changes, these follow.

export type Me = Awaited<ReturnType<typeof api.me>>;
export type Space = Awaited<ReturnType<typeof api.mySpaces>>[number];
export type SpaceDetail = Awaited<ReturnType<typeof api.getSpace>>;
export type Permission = Space['permission'];
export type Page = Awaited<ReturnType<typeof api.listChildPages>>['items'][number];
export type PageDetail = Awaited<ReturnType<typeof api.getPage>>;
export type FolderDetail = Awaited<ReturnType<typeof api.getFolder>>;
/** Which of the two node kinds the tree holds. */
export type NodeKind = Page['kind'];
export type Attachment = Awaited<ReturnType<typeof api.listAttachments>>['items'][number];
export type SearchItem = Awaited<ReturnType<typeof api.search>>['items'][number];
/** User groups and role groups come back in one shape, so one type covers both. */
export type Group = Awaited<ReturnType<typeof api.listUserGroups>>[number];
export type DirectoryUser = Awaited<ReturnType<typeof api.findUsers>>['users'][number];
export type Grant = Awaited<ReturnType<typeof api.listRoleGroupGrants>>[number];
/** Every space, as only a global administrator sees them: no permission column. */
export type AdminSpace = Awaited<ReturnType<typeof api.listSpaces>>[number];
/**
 * The level a grant carries. Distinct from `Permission`, which is what the
 * caller holds on a space and is therefore `undefined` when they hold nothing.
 */
export type GrantLevel = Grant['permission'];

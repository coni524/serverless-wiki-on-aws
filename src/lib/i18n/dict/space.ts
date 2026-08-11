/** Spaces, the space list, and the page tree. See `common.ts` for the shape. */

/**
 * The two kinds a row can be. Several entries below word a sentence around one,
 * and English puts the word in a different place from Japanese, so the kind is
 * passed in raw and each language picks its own word.
 */
type Kind = 'page' | 'folder';

// Every entry that picks between fixed wordings is annotated `: string`.
// Without it the type derived from `ja` is the union of those very Japanese
// literals, and no English wording can satisfy it.

export const ja = {
  // ─── The page tree ─────────────────────────────────────────────────────────
  treeLabel: 'ページツリー',
  treeEmpty: 'ページはまだありません',
  /** Read out in place of the loading row, which has no text of its own. */
  loadingAnnouncement: '読み込み中',
  loadMore: 'さらに読み込む…',
  loadMoreAnnouncement: 'さらに読み込む',
  untitled: '（無題）',

  /** The title input: what it stands empty as, and what it is announced as. */
  titlePlaceholder: (kind: Kind): string => (kind === 'folder' ? 'フォルダー名' : 'ページタイトル'),
  newNodeAnnouncement: (kind: Kind): string =>
    kind === 'folder' ? '新しいフォルダーの名前' : '新しいページの名前',
  renameAnnouncement: (title: string) => `${title} の名前を変更`,

  /** The two controls a row reveals on hover, named for screen readers. */
  rowActions: (title: string) => `${title} の操作`,
  addInside: (title: string) => `${title} の中に追加`,
  createPage: 'ページを作成',
  createFolder: 'フォルダーを作成',

  // ─── The delete dialog ─────────────────────────────────────────────────────
  deleteHeader: (kind: Kind): string => (kind === 'folder' ? 'フォルダーを削除' : 'ページを削除'),
  deleteConfirm: (title: string) => `「${title}」を削除します。元には戻せません。`,
  /** Shown once the API has refused the delete because the node holds children. */
  deleteChildHeader: (kind: Kind): string =>
    kind === 'folder' ? 'フォルダーの中に項目があります' : '子ページがあります',
  deleteChildPrompt: (kind: Kind, count: string | null): string => {
    const held = kind === 'folder' ? '項目' : '子ページ';
    const what = kind === 'folder' ? 'フォルダー' : 'ページ';
    const amount = count === null ? '' : `${count}件`;
    return `この${what}には${held}が${amount}あります。まとめて削除するか、${held}を親に繰り上げてから削除するかを選んでください。`;
  },
  reparentAndDelete: (kind: Kind): string =>
    kind === 'folder' ? '中身を親に繰り上げて削除' : '子ページを親に繰り上げて削除',
  cascadeDelete: (kind: Kind): string => (kind === 'folder' ? '中身ごと削除' : '子ページごと削除'),

  // ─── The navigation panel's header ─────────────────────────────────────────
  addToSpaceRoot: 'スペース直下に追加',
  switchSpace: 'スペースを切り替え',
  searchSpaces: 'スペースを検索',
  allSpaces: 'スペース一覧',
  /** What the switcher reads as until the listing that names the space lands. */
  spaceFallback: 'スペース',

  // ─── The space list ────────────────────────────────────────────────────────
  listHeading: 'スペース',
  reload: '再読み込み',
  createSpace: 'スペースを作成',
  noSpaces: (isGlobalAdmin: boolean): string =>
    isGlobalAdmin
      ? '読めるスペースがありません。「スペースを作成」から最初のスペースを作成してください。'
      : '読めるスペースがありません。管理者にアクセス権の付与を依頼してください。',
  spaceName: 'スペース名',
  description: '説明',
  optional: '任意',

  // ─── The space's own landing panel ─────────────────────────────────────────
  loadingSpace: 'スペースを読み込み中…',
  breadcrumbLabel: 'パンくずリスト',
  noDescription: '説明はありません。',
  pickFromTree: (editable: boolean): string =>
    editable
      ? '左のツリーからページを選ぶか、「＋」から最初のページかフォルダーを作成してください。'
      : '左のツリーからページを選ぶか、閲覧できるページを開いてください。',
};

export type Space = typeof ja;

export const en: Space = {
  treeLabel: 'Page tree',
  treeEmpty: 'No pages yet',
  loadingAnnouncement: 'Loading',
  loadMore: 'Load more…',
  loadMoreAnnouncement: 'Load more',
  untitled: '(untitled)',

  titlePlaceholder: (kind) => (kind === 'folder' ? 'Folder name' : 'Page title'),
  newNodeAnnouncement: (kind) => (kind === 'folder' ? 'New folder name' : 'New page name'),
  renameAnnouncement: (title) => `Rename ${title}`,

  rowActions: (title) => `Actions for ${title}`,
  addInside: (title) => `Add inside ${title}`,
  createPage: 'Create page',
  createFolder: 'Create folder',

  deleteHeader: (kind) => (kind === 'folder' ? 'Delete folder' : 'Delete page'),
  deleteConfirm: (title) => `“${title}” will be deleted. This cannot be undone.`,
  deleteChildHeader: (kind) =>
    kind === 'folder' ? 'This folder is not empty' : 'This page has child pages',
  deleteChildPrompt: (kind, count) => {
    const one = count === '1';
    const held = kind === 'folder' ? (one ? 'item' : 'items') : one ? 'child page' : 'child pages';
    const what = kind === 'folder' ? 'folder' : 'page';
    const amount = count === null ? held : `${count} ${held}`;
    return `This ${what} holds ${amount}. Choose whether to delete them together, or to move them up to the parent first.`;
  },
  reparentAndDelete: (kind) =>
    kind === 'folder' ? 'Move the contents up and delete' : 'Move the child pages up and delete',
  cascadeDelete: (kind) =>
    kind === 'folder' ? 'Delete with its contents' : 'Delete with its child pages',

  addToSpaceRoot: 'Add at the space root',
  switchSpace: 'Switch space',
  searchSpaces: 'Search spaces',
  allSpaces: 'All spaces',
  spaceFallback: 'Space',

  listHeading: 'Spaces',
  reload: 'Reload',
  createSpace: 'Create space',
  noSpaces: (isGlobalAdmin) =>
    isGlobalAdmin
      ? 'There are no spaces you can read. Use “Create space” to create the first one.'
      : 'There are no spaces you can read. Ask an administrator for access.',
  spaceName: 'Space name',
  description: 'Description',
  optional: 'Optional',

  loadingSpace: 'Loading the space…',
  breadcrumbLabel: 'Breadcrumbs',
  noDescription: 'No description.',
  pickFromTree: (editable) =>
    editable
      ? 'Pick a page from the tree on the left, or use “+” to create the first page or folder.'
      : 'Pick a page from the tree on the left to start reading.',
};

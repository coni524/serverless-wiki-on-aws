/** Reading and editing a page or folder, attachments, and search. See `common.ts`. */

export const ja = {
  /** A node saved with an empty title. Every screen that lists nodes shows this. */
  untitled: '（無題）',
  /** The breadcrumb, and the two steps every one of them starts with. */
  breadcrumbAria: 'パンくずリスト',
  spacesRoot: 'スペース一覧',
  backToSpace: 'スペースへ戻る',

  // ─── One page ───
  loadingPage: 'ページを読み込み中…',
  editHeading: 'ページを編集',
  /** The line under the title. A page that has never been saved has no time. */
  pageMeta: (revision: number, updatedAt: string | null): string =>
    `リビジョン ${revision}${updatedAt === null ? '' : ` · 最終更新 ${updatedAt}`}`,
  emptyBody: '本文はまだありません。',
  imagesFailed: (reason: string): string => `画像を読み込めませんでした: ${reason}`,
  pageUnavailable: 'ページを表示できません',

  // ─── One folder ───
  loadingFolder: 'フォルダーを読み込み中…',
  addHere: 'この中に追加',
  createPage: 'ページを作成',
  createFolder: 'フォルダーを作成',
  columnName: '名前',
  columnUpdatedAt: '最終更新',
  emptyFolder: 'このフォルダーは空です。',
  loadMore: 'さらに読み込む…',
  folderUnavailable: 'フォルダーを表示できません',

  // ─── The editor ───
  titleLabel: 'ページタイトル',
  bodyLabel: '本文',
  bodyDescription: 'Markdown で書きます。画像はドラッグ&ドロップか貼り付けで追加できます',
  /** Named as `reason` below, because it is what says why a file was refused. */
  embeddableTypes: '本文に貼り付けられる画像は PNG、JPEG、GIF、WebP、AVIF です',
  skippedFiles: (count: number, reason: string): string => `${count} 件を追加しませんでした。${reason}`,
  uploadingImages: (count: number): string => `画像をアップロード中です（残り ${count} 件）。`,
  uploadFailed: (status: number): string => `アップロードに失敗しました (HTTP ${status})`,

  // ─── Attachments ───
  attachments: '添付ファイル',
  addFile: 'ファイルを追加',
  /** On the upload button while a file is on its way to S3. */
  working: '処理中…',
  columnFilename: 'ファイル名',
  columnSize: 'サイズ',
  columnUploadedAt: 'アップロード日時',
  noAttachments: '添付はありません。',
  deleteAttachment: '添付ファイルを削除',
  deleteAttachmentBody: (filename: string): string => `「${filename}」を削除します。元に戻せません。`,

  // ─── Search ───
  searchPlaceholder: 'ページを検索…',
  searchAriaLabel: 'ページを検索',
  searchHeading: '検索',
  resultsHeading: (query: string): string => `「${query}」の検索結果`,
  /** The scope line, followed by the link out of it — hence two entries. */
  searchScope: (spaceName: string): string => `スペース「${spaceName}」内を検索しています。`,
  searchAllSpaces: 'すべてのスペースを検索',
  searchAgain: '再検索',
  searchPrompt: '上の検索ボックスに検索語を入力してください。',
  searching: '検索中…',
  searchFailed: (reason: string): string => `検索できませんでした：${reason}`,
  noResults: '一致するページが見つかりませんでした。',
  noResultsHint: '保存したばかりのページは、検索に反映されるまで数分かかることがあります。',
  /** The suggestion list under the search box. */
  suggestLoading: '候補を探しています…',
  suggestEmpty: '候補はありません。',
  suggestUseQuery: (query: string): string => `「${query}」で検索`,

  // ─── Markdown ───
  /** What `<Markdown>` shows on its own, as opposed to `emptyBody` above it. */
  emptyBodyInline: '（本文はまだありません）',
  /** Stands in for an image whose attachment is gone and that carries no alt. */
  imageUnavailable: '（画像を表示できません）',
};

export type Page = typeof ja;

export const en: Page = {
  untitled: '(untitled)',
  breadcrumbAria: 'Breadcrumbs',
  spacesRoot: 'Spaces',
  backToSpace: 'Back to the space',

  loadingPage: 'Loading the page…',
  editHeading: 'Edit page',
  pageMeta: (revision: number, updatedAt: string | null) =>
    `Revision ${revision}${updatedAt === null ? '' : ` · Last updated ${updatedAt}`}`,
  emptyBody: 'This page has no content yet.',
  imagesFailed: (reason: string) => `Could not load the images: ${reason}`,
  pageUnavailable: 'Cannot show this page',

  loadingFolder: 'Loading the folder…',
  addHere: 'Add in here',
  createPage: 'Create page',
  createFolder: 'Create folder',
  columnName: 'Name',
  columnUpdatedAt: 'Last updated',
  emptyFolder: 'This folder is empty.',
  loadMore: 'Load more…',
  folderUnavailable: 'Cannot show this folder',

  titleLabel: 'Page title',
  bodyLabel: 'Body',
  bodyDescription: 'Written in Markdown. Add images by dropping or pasting them',
  embeddableTypes: 'The body takes PNG, JPEG, GIF, WebP and AVIF images',
  skippedFiles: (count: number, reason: string) =>
    `Did not add ${count === 1 ? '1 file' : `${count} files`}. ${reason}`,
  uploadingImages: (count: number) =>
    `Uploading ${count === 1 ? '1 image' : `${count} images`}…`,
  uploadFailed: (status: number) => `Upload failed (HTTP ${status})`,

  attachments: 'Attachments',
  addFile: 'Add file',
  working: 'Working…',
  columnFilename: 'File name',
  columnSize: 'Size',
  columnUploadedAt: 'Uploaded',
  noAttachments: 'No attachments.',
  deleteAttachment: 'Delete attachment',
  deleteAttachmentBody: (filename: string) =>
    `Deleting “${filename}”. This cannot be undone.`,

  searchPlaceholder: 'Search pages…',
  searchAriaLabel: 'Search pages',
  searchHeading: 'Search',
  resultsHeading: (query: string) => `Results for “${query}”`,
  searchScope: (spaceName: string) => `Searching in the space “${spaceName}”.`,
  searchAllSpaces: 'Search all spaces',
  searchAgain: 'Search again',
  searchPrompt: 'Type what you are looking for in the search box above.',
  searching: 'Searching…',
  searchFailed: (reason: string) => `Could not search: ${reason}`,
  noResults: 'No pages matched.',
  noResultsHint: 'A page saved a moment ago can take a few minutes to reach search.',
  suggestLoading: 'Looking for suggestions…',
  suggestEmpty: 'No suggestions.',
  suggestUseQuery: (query: string) => `Search for “${query}”`,

  emptyBodyInline: '(no content yet)',
  imageUnavailable: '(image unavailable)',
};

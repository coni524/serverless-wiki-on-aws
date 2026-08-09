/** The AI assistant panel and the pending-change approval screen. See `common.ts`. */

export const ja = {
  /** The drawer's own heading, drawn inside the panel above the conversation. */
  title: 'AI アシスタント',
  startOver: '新しい会話',

  inputPlaceholder: '質問や依頼を入力…',
  inputAriaLabel: 'AI アシスタントへの入力',
  send: '送信',

  emptyState:
    'Wiki の内容について質問できます。ページの作成・更新・削除を頼んだときは、実行前に確認します。',
  thinking: '考え中…',

  /** Who wrote a message, and what became of an approval the user answered. */
  you: 'あなた',
  assistant: 'アシスタント',
  approved: '承認しました。',
  discarded: '実行しませんでした。',

  approvalHeader: '確認待ちの変更があります',
  approvalHint: '左の「変更の確認」で内容を確かめられます。',
  approve: '承認して実行',
  discard: '破棄',

  /**
   * The agent's tools, named for the reader.
   *
   * Read while a tool runs and on the approval card, so a tool the model calls
   * is never shown by its API name. A name with no entry here falls back to the
   * name itself — see `toolLabel` in `components/AiAssistant.tsx`.
   */
  tool: {
    searchWiki: 'ページを検索',
    listSpaces: 'スペースを一覧',
    readPage: 'ページを読む',
    createPage: 'ページを作成',
    updatePage: 'ページを更新',
    deletePage: 'ページを削除',
  },

  /** The review screen in the content area (`components/PendingChange.tsx`). */
  reviewHeading: '変更の確認',
  reviewDescription:
    'AI アシスタントが次の変更を求めています。承認するまで Wiki には書き込まれません。内容を確かめたら、右の AI アシスタントで承認するか破棄するかを選んでください。',

  createHeading: (title: string): string => `ページを作成：${title}`,
  updateHeading: (title: string): string => `ページを更新：${title}`,
  deleteHeading: (title: string): string => `ページを削除：${title}`,

  /** Where a new page would land, as far as the tool's input says. */
  underParent: (parent: string): string => `${parent} の下に作成`,
  underSpace: (space: string): string => `${space} の直下に作成`,
  /** What joins a page's ancestors into the one-line subtitle. */
  breadcrumbSeparator: ' ／ ',

  loadingCurrent: '現在のページを読み込み中…',
  loadCurrentFailed: (reason: string): string => `現在のページを読み込めませんでした：${reason}`,
  loadingTarget: '削除するページを読み込み中…',
  loadTargetFailed: (reason: string): string => `削除するページを読み込めませんでした：${reason}`,

  titleField: 'タイトル',
  titleUnchanged: 'タイトルは変わりません。',

  bodyEmpty: '本文は空です。',
  bodyEmptyPage: '本文は空のページです。',
  bodyUnchanged: '本文は変わりません。',
  bodyTooLarge: '本文が長いため差分は表示しません。置き換え後の全文を示します。',
  bodyWillBeEmpty: '本文は空になります。',
  bodyChanges: (added: number, removed: number): string => `本文（+${added} −${removed} 行）`,
};

export type Assistant = typeof ja;

export const en: Assistant = {
  title: 'AI assistant',
  startOver: 'New conversation',

  inputPlaceholder: 'Ask a question or make a request…',
  inputAriaLabel: 'Message the AI assistant',
  send: 'Send',

  emptyState:
    'Ask about anything in the wiki. When you ask for a page to be created, updated or deleted, you are asked to confirm before it runs.',
  thinking: 'Thinking…',

  you: 'You',
  assistant: 'Assistant',
  approved: 'Approved.',
  discarded: 'Discarded.',

  approvalHeader: 'Waiting for your approval',
  approvalHint: 'You can check the details under “Review change” on the left.',
  approve: 'Approve and run',
  discard: 'Discard',

  tool: {
    searchWiki: 'Search pages',
    listSpaces: 'List spaces',
    readPage: 'Read page',
    createPage: 'Create page',
    updatePage: 'Update page',
    deletePage: 'Delete page',
  },

  reviewHeading: 'Review change',
  reviewDescription:
    'The AI assistant is asking to make the following change. Nothing is written to the wiki until you approve it. Once you have checked it, approve or discard it in the AI assistant on the right.',

  createHeading: (title: string): string => `Create page: ${title}`,
  updateHeading: (title: string): string => `Update page: ${title}`,
  deleteHeading: (title: string): string => `Delete page: ${title}`,

  underParent: (parent: string): string => `Under ${parent}`,
  underSpace: (space: string): string => `Directly under ${space}`,
  breadcrumbSeparator: ' / ',

  loadingCurrent: 'Loading the current page…',
  loadCurrentFailed: (reason: string): string => `Could not load the current page: ${reason}`,
  loadingTarget: 'Loading the page to delete…',
  loadTargetFailed: (reason: string): string => `Could not load the page to delete: ${reason}`,

  titleField: 'Title',
  titleUnchanged: 'The title does not change.',

  bodyEmpty: 'The body is empty.',
  bodyEmptyPage: 'This page has an empty body.',
  bodyUnchanged: 'The body does not change.',
  bodyTooLarge: 'The body is too long to diff. The full replacement text is shown instead.',
  bodyWillBeEmpty: 'The body becomes empty.',
  bodyChanges: (added: number, removed: number): string =>
    `Body (+${added} / −${removed} ${added + removed === 1 ? 'line' : 'lines'})`,
};

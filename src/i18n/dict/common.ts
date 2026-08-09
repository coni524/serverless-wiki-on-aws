/**
 * Words more than one area of the screen needs.
 *
 * Every dictionary module in this directory follows the same shape: `ja` is
 * written first and is what the type is derived from, and `en` is annotated
 * with that type. A key missing from `en`, a key `ja` does not have, or an
 * interpolation whose arguments drifted apart is then a type error rather than
 * a string that silently falls back to the wrong language.
 *
 * Keep this module to wording that genuinely recurs. An area that needs a word
 * of its own puts it in its own module, so the two do not have to be edited
 * together.
 */

export const ja = {
  save: '保存',
  cancel: 'キャンセル',
  delete: '削除',
  create: '作成',
  rename: '名前を変更',
  edit: '編集',
  close: '閉じる',
  add: '追加',
  loading: '読み込み中…',
  /**
   * The two kinds of node the tree holds. Several screens name them — the tree,
   * an open folder, the assistant's approval card — so the words live here.
   */
  kind: { page: 'ページ', folder: 'フォルダー' },
  /** Shown when the thrown value carried nothing a message could be read from. */
  unknownError: '不明なエラーが発生しました',
  /** The empty choice in a dropdown that may be left unset. */
  notSet: '（設定しない）',
  /** Stands in for a value a row does not have. */
  empty: '—',
};

export type Common = typeof ja;

export const en: Common = {
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  create: 'Create',
  rename: 'Rename',
  edit: 'Edit',
  close: 'Close',
  add: 'Add',
  loading: 'Loading…',
  kind: { page: 'Page', folder: 'Folder' },
  unknownError: 'Something went wrong',
  notSet: '(not set)',
  empty: '—',
};

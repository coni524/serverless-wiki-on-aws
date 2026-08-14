/** The shell: top bar, account menu, sign-in screen, and the shell's own states. */

export const ja = {
  /** The assistant drawer, named for screen readers and for its trigger button. */
  assistantDrawer: 'AI アシスタント',
  resizeAssistant: 'パネルの幅を変更',
  resizeNavigation: 'ナビゲーションの幅を変更',

  checkingSession: 'サインイン状態を確認中…',
  loadingUser: 'ユーザー情報を読み込み中…',
  identityFailed: (reason: string) => `サインイン情報を取得できませんでした：${reason}`,

  /** The account menu. `language` labels the switcher beside it. */
  admin: '管理',
  signOut: 'サインアウト',
  language: '言語',

  signInHeading: 'サインイン',
  signInPrompt: '続けるにはサインインしてください。',

  /** The first sign-in, where the pool asks the reader to enrol an authenticator. */
  totpScanIntro: '認証アプリで次の QR コードを読み取り、表示された 6 桁を下に入力してください。',
  totpTypeIntro: 'QR コードを読み取れないときは、次のキーを認証アプリに手で登録してください。',
  totpQrLabel: '認証アプリ登録用の QR コード',
  totpCopyKey: 'キーをコピー',
  totpCopied: 'コピーしました',
  totpSecretMissing:
    '登録用のキーを受け取れませんでした。ページを再読み込みしてサインインからやり直してください。',

  openingPage: 'ページを開いています…',
  openPageFailed: (reason: string) => `ページを開けませんでした：${reason}`,

  notFoundHeading: 'ページが見つかりません',
  notFoundBody: 'URL を確認してください。',
  backToSpaces: 'スペース一覧へ戻る',
};

export type App = typeof ja;

export const en: App = {
  assistantDrawer: 'AI assistant',
  resizeAssistant: 'Resize panel',
  resizeNavigation: 'Resize navigation',

  checkingSession: 'Checking your session…',
  loadingUser: 'Loading your details…',
  identityFailed: (reason: string) => `Could not load your sign-in details: ${reason}`,

  admin: 'Administration',
  signOut: 'Sign out',
  language: 'Language',

  signInHeading: 'Sign in',
  signInPrompt: 'Sign in to continue.',

  totpScanIntro: 'Scan this QR code with your authenticator app, then enter the six digits it shows.',
  totpTypeIntro: 'If you cannot scan it, add this key to your authenticator app by hand.',
  totpQrLabel: 'QR code for enrolling an authenticator app',
  totpCopyKey: 'Copy key',
  totpCopied: 'Copied',
  totpSecretMissing:
    'No enrolment key arrived. Reload the page and sign in again.',

  openingPage: 'Opening the page…',
  openPageFailed: (reason: string) => `Could not open the page: ${reason}`,

  notFoundHeading: 'Page not found',
  notFoundBody: 'Check the URL.',
  backToSpaces: 'Back to spaces',
};

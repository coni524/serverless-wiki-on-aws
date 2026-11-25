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

  /** The federated way in, shown only when the deployment has an IdP configured. */
  signInWithProvider: (provider: string) => `${provider} でサインイン`,
  signInOrPassword: 'または、メールアドレスとパスワードでサインイン',

  /** The first sign-in, where the pool asks the reader to enrol an authenticator. */
  totpScanIntro: '認証アプリで次の QR コードを読み取り、表示された 6 桁を下に入力してください。',
  totpTypeIntro: 'QR コードを読み取れないときは、次のキーを認証アプリに手で登録してください。',
  totpQrLabel: '認証アプリ登録用の QR コード',
  totpCopyKey: 'キーをコピー',
  totpCopied: 'コピーしました',
  totpSecretMissing:
    '登録用のキーを受け取れませんでした。ページを再読み込みしてサインインからやり直してください。',
  /** Passkey sign-in for an account that has none: the pool asks which way in instead. */
  noPasskeyFallback:
    'このアカウントにはパスキーが登録されていません。下の「Choose Sign-In Method」を押すと、パスワードの入力に進みます。そのあと認証アプリの 6 桁を入力してください。',

  /** The passkey dialog, opened from the account menu (password accounts only). */
  passkeys: 'パスキー',
  passkeysIntro:
    'パスキーを登録すると、この画面ではパスワードと認証アプリのコードを入れずに、端末の指紋・顔・PIN だけでサインインできます。パスワードと認証アプリは、端末をなくしたときの予備として残ります。',
  passkeysClientsNote:
    'MCP や Obsidian のサインインでは、これまでどおりパスワードと認証アプリのコードを使います。',
  passkeysEmpty: 'まだパスキーはありません。',
  passkeyAdd: 'この端末にパスキーを追加',
  passkeyUnnamed: '名前のないパスキー',
  passkeyCreatedAt: (date: string) => `登録日：${date}`,
  passkeyAdded: 'パスキーを追加しました。次からはパスキーでサインインできます。',
  passkeyDeleted: 'パスキーを削除しました。',
  passkeyCancelled: 'パスキーの作成を取り消しました。',
  passkeyAlreadyHere: 'この端末には、このアカウントのパスキーがすでにあります。',
  passkeyUnsupported: 'このブラウザはパスキーに対応していません。',
  passkeyReauth:
    '安全のため、パスキーの追加と削除はサインインした直後に限っています。いったんサインアウトして、サインインし直してください。',
  passkeyFailed: (reason: string) => `パスキーを処理できませんでした：${reason}`,

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

  signInWithProvider: (provider: string) => `Sign in with ${provider}`,
  signInOrPassword: 'Or sign in with your email address and password',

  totpScanIntro: 'Scan this QR code with your authenticator app, then enter the six digits it shows.',
  totpTypeIntro: 'If you cannot scan it, add this key to your authenticator app by hand.',
  totpQrLabel: 'QR code for enrolling an authenticator app',
  totpCopyKey: 'Copy key',
  totpCopied: 'Copied',
  totpSecretMissing:
    'No enrolment key arrived. Reload the page and sign in again.',
  noPasskeyFallback:
    'This account has no passkey. Press "Choose Sign-In Method" below to continue with your password, then enter the six-digit code from your authenticator app.',

  passkeys: 'Passkeys',
  passkeysIntro:
    'With a passkey, you sign in here with your device’s fingerprint, face or PIN alone, without your password or an authenticator code. Your password and authenticator app stay as the way back in if you lose the device.',
  passkeysClientsNote:
    'Signing in from MCP clients or Obsidian still uses your password and an authenticator code.',
  passkeysEmpty: 'No passkeys yet.',
  passkeyAdd: 'Add a passkey on this device',
  passkeyUnnamed: 'Unnamed passkey',
  passkeyCreatedAt: (date: string) => `Added ${date}`,
  passkeyAdded: 'Passkey added. You can sign in with it from now on.',
  passkeyDeleted: 'Passkey removed.',
  passkeyCancelled: 'Passkey creation was cancelled.',
  passkeyAlreadyHere: 'This device already has a passkey for this account.',
  passkeyUnsupported: 'This browser does not support passkeys.',
  passkeyReauth:
    'For your security, passkeys can only be added or removed shortly after signing in. Sign out and sign in again.',
  passkeyFailed: (reason: string) => `Could not complete the passkey request: ${reason}`,

  openingPage: 'Opening the page…',
  openPageFailed: (reason: string) => `Could not open the page: ${reason}`,

  notFoundHeading: 'Page not found',
  notFoundBody: 'Check the URL.',
  backToSpaces: 'Back to spaces',
};

/**
 * Every string the plugin shows a person, in Japanese and in English.
 *
 * The language is Obsidian's own, not a setting of this plugin. Obsidian writes
 * the chosen UI language to `localStorage` under `language` only when somebody
 * picks one by hand; while it follows the system locale the key is absent, so a
 * Japanese Mac whose owner never opened that setting stores nothing there.
 * Either way the language on screen is the one moment is set to. Changing it
 * needs a reload of the app, so the dictionary is chosen once when this module
 * loads and never looked up again.
 *
 * The Japanese half is the source: `Messages` is derived from it, so a key
 * added there is a type error in the English half until it is translated. Every
 * function states `: string` as its return type — without it a function whose
 * branches return literals is inferred as the union of those literals, which
 * the other language cannot satisfy.
 */
import { moment } from 'obsidian';

import type { SyncReport } from './report';

const ja = {
  // ─── Settings: the deployment ──────────────────────────────────────────────
  connectionHeading: '接続先',
  wikiUrlName: 'Wiki の URL',
  wikiUrlDesc: 'sl-wiki を開くときのアドレス。末尾の「/」は付けても付けなくてもよい。',
  clientIdName: 'クライアント ID',
  clientIdDesc: 'デプロイのスタック出力 McpClientId の値。',
  clientIdPlaceholder: '例: 1a2b3c4d5e6f7g8h9i0j',

  // ─── Settings: signing in ──────────────────────────────────────────────────
  signInHeading: 'サインイン',
  signInStatusName: '状態',
  signOutButton: 'サインアウト',
  signedOutNotice: 'サインアウトしました。',
  signInButton: 'サインイン',
  signInInBrowser: 'ブラウザでサインインしてください。',
  signedInNotice: 'sl-wiki にサインインしました。',
  signedOutStatus: 'サインインしていません。',
  unknownUser: '不明な利用者',
  noScopes: 'なし',
  signedInStatus: (who: string, scopes: string, expiry: string): string =>
    `${who} としてサインイン済み。スコープ: ${scopes}。アクセストークンの期限: ${expiry}（期限が来たら自動で更新する）。`,

  checkConnectionName: '接続を確認',
  checkConnectionDesc: '読める権限のあるスペースを 1 回取得して、往復が通ることを確かめる。',
  checkConnectionButton: '確認',
  unknownPermission: '不明',
  spaceWithPermission: (name: string, permission: string): string => `${name}（${permission}）`,
  connectedNoSpaces: '接続できました。読めるスペースはありません。',
  connectedSpaces: (names: string[]): string =>
    `接続できました。読めるスペース ${names.length} 件: ${names.join('、')}`,
  connectedSpaceCount: (spaces: number): string =>
    `接続できました。読めるスペースは ${spaces} 件です。`,

  tokenWarningTitle: 'トークンの置き場所について。',
  tokenWarningBody:
    ' サインインで得たトークンは、保管庫の中の ' +
    '.obsidian/plugins/slwiki-sync/data.json に平文で保存される。' +
    'この保管庫を他の同期サービス（iCloud など）に載せている場合は、' +
    'トークンもそこへ複製される。使わなくなったらサインアウトすると、' +
    'Cognito 側でも無効になる。',

  // ─── Settings: syncing ─────────────────────────────────────────────────────
  syncHeading: '同期',
  syncedSpacesName: '同期するスペース',
  syncedSpacesDesc: (selected: number): string =>
    (selected === 0 ? 'まだ選ばれていない。' : `${selected} 件を同期する。`) +
    '取得したスペースは、保管庫の直下に同名のフォルダとして作られる。',
  fetchSpacesButton: '一覧を取得',
  noReadableSpaces: '読めるスペースがありません。',
  spaceNotListed: (spaceId: string): string => `${spaceId}（一覧に無い）`,
  spaceUnknownDesc:
    '権限は一覧を取得するまで分からない。' +
    '送るかどうかは、この画面ではなく同期のたびに Wiki へ問い合わせて決まる。',
  spaceDesc: (permission: string, twoWay: boolean): string =>
    `権限: ${permission}。` +
    (twoWay
      ? '手元の追加・編集・改名・移動を Wiki へ送る。'
      : '取得のみ（書き込む権限が無いので送らない）。'),

  pushDeleteName: '手元で消したノートを Wiki からも消す',
  pushDeleteDesc:
    '既定では消さず、次の同期で Wiki から取得し直す。' +
    '有効にすると、保管庫から消えたノートに対応するページを Wiki から削除する。' +
    '本文は回収ジョブが消すので、取り消せない。',

  intervalName: '自動同期の間隔（分）',
  intervalDesc: '0 にすると自動では同期せず、コマンドと下のボタンだけになる。',

  syncNowName: 'いま同期する',
  syncNowButton: '同期',
  noSyncYet: 'このセッションではまだ同期していない。',
  lastSync: (at: string, report: string): string => `最後の同期: ${at}。${report}。`,

  forgetName: '同期の記録を消す',
  forgetDesc:
    'ページとファイルの対応表を捨てて、次の同期で全ページを取得し直す。' +
    '保管庫のファイルは消さない。手元で編集したファイルは、上書きではなく別名で退避される。',
  forgetButton: '消す',
  forgotNotice: '同期の記録を消した。次の同期で全ページを取得し直す。',

  actionFailed: (message: string): string => `失敗しました: ${message}`,

  // ─── Commands ──────────────────────────────────────────────────────────────
  commandSignIn: 'サインインする',
  commandCheckConnection: '接続を確認する',
  commandSyncNow: 'いま同期する',

  // ─── Running a cycle ───────────────────────────────────────────────────────
  syncAlreadyRunning: '同期はすでに実行中です。',
  noSpacesSelected: '同期するスペースが選ばれていません。設定画面で選んでください。',
  notSignedIn: 'サインインしていません。設定画面からサインインしてください。',
  syncDone: (report: string): string => `同期しました。${report}`,
  syncFailed: (message: string): string => `同期に失敗しました: ${message}`,
  recordUpdateFailed: (message: string): string => `同期の記録を更新できませんでした: ${message}`,
  spaceUnreadable: (spaceId: string): string => `スペース ${spaceId} は読めませんでした`,
  pushFolderMissing: (spaceName: string, folder: string): string =>
    `${spaceName}: フォルダ ${folder} が見当たらないので送信は見送りました`,

  // ─── What a cycle did ──────────────────────────────────────────────────────
  syncReport: (report: SyncReport): string => {
    const pulled =
      `取得 ${report.fetched}、移動 ${report.moved}、削除 ${report.removed}、` +
      `退避 ${report.conflicts}（変更なし ${report.unchanged}）`;
    const pushed =
      `送信 作成 ${report.created}、更新 ${report.updated}、` +
      `移動 ${report.relocated}、削除 ${report.deleted}`;
    const attachments =
      report.downloaded + report.uploaded === 0
        ? ''
        : `。添付 取得 ${report.downloaded}、送信 ${report.uploaded}`;
    const skipped =
      report.skipped === 0 ? '' : `。置き場所を決められないページ ${report.skipped} 件`;
    const failures =
      report.failures.length === 0
        ? ''
        : `。失敗 ${report.failures.length} 件: ${report.failures.join(' / ')}`;
    return `${pulled}。${pushed}${attachments}${skipped}${failures}`;
  },

  // ─── Signing in: what went wrong ───────────────────────────────────────────
  signInNotCompleted: (detail: string): string => `サインインは完了しませんでした: ${detail}`,
  noPendingSignIn: '進行中のサインインがありません。設定画面からやり直してください。',
  signInMismatch: 'サインインの応答が要求と一致しませんでした。やり直してください。',
  signInNoCode: 'サインインの応答に認可コードがありませんでした。',
  noRefreshToken: 'リフレッシュトークンが返りませんでした。',
  signInExpired: 'サインインの有効期限が切れました。もう一度サインインしてください。',
  configMissing: 'Wiki の URL とクライアント ID を先に設定してください。',
  discoveryUnreachable: (url: string, detail: string): string =>
    `${url} に接続できませんでした: ${detail}`,
  discoveryStatus: (url: string, status: number): string =>
    `${url} が ${status} を返しました。Wiki の URL を確認してください。`,
  discoveryNotJson: (url: string): string =>
    `${url} の応答が JSON ではありません。Wiki の URL を確認してください。`,
  discoveryNoEndpoints: (url: string): string =>
    `${url} の応答に認可・トークンのエンドポイントがありません。`,
  tokenRequestFailed: (detail: string): string => `トークンの取得に失敗しました (${detail})`,
  tokenResponseUnexpected: 'トークンの応答が想定した形ではありません。',
  webCryptoMissing: 'この環境では PKCE に必要な Web Crypto が使えません。',

  // ─── Talking to the Wiki ───────────────────────────────────────────────────
  wikiUrlMissing: 'Wiki の URL が設定されていません。',
  pageListUnfinished: (spaceId: string): string =>
    `スペース ${spaceId} のページ一覧が終わりませんでした。`,
  requestRefused: (method: string, status: number, detail: string): string =>
    `${method} が ${status} で断られました${detail === '' ? '' : `: ${detail}`}`,

  // ─── Attachments ───────────────────────────────────────────────────────────
  attachmentFailure: (attachmentId: string, message: string): string =>
    `添付 ${attachmentId}: ${message}`,
  downloadRefused: (status: number): string => `ダウンロードが ${status} で断られました`,
  uploadRefused: (status: number): string => `アップロードが ${status} で断られました`,
  cannotCreateFolder: (path: string): string => `${path} を作れません`,
};

type Messages = typeof ja;

const en: Messages = {
  connectionHeading: 'Connection',
  wikiUrlName: 'Wiki URL',
  wikiUrlDesc: 'The address you open sl-wiki at. A trailing "/" is optional.',
  clientIdName: 'Client ID',
  clientIdDesc: 'The McpClientId value from the deployment stack outputs.',
  clientIdPlaceholder: 'e.g. 1a2b3c4d5e6f7g8h9i0j',

  signInHeading: 'Sign in',
  signInStatusName: 'Status',
  signOutButton: 'Sign out',
  signedOutNotice: 'Signed out.',
  signInButton: 'Sign in',
  signInInBrowser: 'Finish signing in in your browser.',
  signedInNotice: 'Signed in to sl-wiki.',
  signedOutStatus: 'Not signed in.',
  unknownUser: 'unknown user',
  noScopes: 'none',
  signedInStatus: (who, scopes, expiry) =>
    `Signed in as ${who}. Scopes: ${scopes}. Access token expires ${expiry} (renewed automatically).`,

  checkConnectionName: 'Check connection',
  checkConnectionDesc: 'Fetch the spaces you can read once, to confirm the round trip works.',
  checkConnectionButton: 'Check',
  unknownPermission: 'unknown',
  spaceWithPermission: (name, permission) => `${name} (${permission})`,
  connectedNoSpaces: 'Connected. There are no spaces you can read.',
  connectedSpaces: (names) =>
    names.length === 1
      ? `Connected. 1 space you can read: ${names[0]}`
      : `Connected. ${names.length} spaces you can read: ${names.join(', ')}`,
  connectedSpaceCount: (spaces) =>
    spaces === 1 ? 'Connected. You can read 1 space.' : `Connected. You can read ${spaces} spaces.`,

  tokenWarningTitle: 'Where the token is kept.',
  tokenWarningBody:
    ' The token from signing in is stored in plain text inside the vault, at ' +
    '.obsidian/plugins/slwiki-sync/data.json. If the vault is carried by another ' +
    'sync service (iCloud and the like), the token is copied there too. Signing ' +
    'out when you no longer need it also invalidates it at Cognito.',

  syncHeading: 'Sync',
  syncedSpacesName: 'Spaces to sync',
  syncedSpacesDesc: (selected) =>
    (selected === 0
      ? 'None selected yet. '
      : selected === 1
        ? 'Syncing 1 space. '
        : `Syncing ${selected} spaces. `) +
    'Each one becomes a folder of the same name at the top of the vault.',
  fetchSpacesButton: 'Fetch list',
  noReadableSpaces: 'There are no spaces you can read.',
  spaceNotListed: (spaceId) => `${spaceId} (not in the list)`,
  spaceUnknownDesc:
    'The permission is unknown until the list arrives. What is sent is settled ' +
    'by asking the Wiki on every sync, not by this screen.',
  spaceDesc: (permission, twoWay) =>
    `Permission: ${permission}. ` +
    (twoWay
      ? 'Local additions, edits, renames and moves are sent to the Wiki.'
      : 'Fetch only — without write permission nothing is sent.'),

  pushDeleteName: 'Delete notes in the Wiki too',
  pushDeleteDesc:
    'By default nothing is deleted, and the next sync fetches the note back from the Wiki. ' +
    'When enabled, a note removed from the vault deletes the page it came from. ' +
    'The reclamation job erases the body, so this cannot be undone.',

  intervalName: 'Automatic sync interval (minutes)',
  intervalDesc: 'Set to 0 to sync only from the command and the button below.',

  syncNowName: 'Sync now',
  syncNowButton: 'Sync',
  noSyncYet: 'No sync yet in this session.',
  lastSync: (at, report) => `Last sync: ${at}. ${report}.`,

  forgetName: 'Clear the sync record',
  forgetDesc:
    'Discard the page-to-file mapping and fetch every page again on the next sync. ' +
    'No file in the vault is deleted; a locally edited file is set aside under another ' +
    'name instead of being overwritten.',
  forgetButton: 'Clear',
  forgotNotice: 'Sync record cleared. Every page will be fetched again on the next sync.',

  actionFailed: (message) => `Failed: ${message}`,

  commandSignIn: 'Sign in',
  commandCheckConnection: 'Check connection',
  commandSyncNow: 'Sync now',

  syncAlreadyRunning: 'A sync is already running.',
  noSpacesSelected: 'No spaces are selected for sync. Choose them in the settings.',
  notSignedIn: 'Not signed in. Sign in from the settings.',
  syncDone: (report) => `Synced. ${report}`,
  syncFailed: (message) => `Sync failed: ${message}`,
  recordUpdateFailed: (message) => `Could not update the sync record: ${message}`,
  spaceUnreadable: (spaceId) => `Space ${spaceId} could not be read`,
  pushFolderMissing: (spaceName, folder) =>
    `${spaceName}: folder ${folder} is missing, so nothing was sent`,

  syncReport: (report) => {
    const pulled =
      `Pulled ${report.fetched}, moved ${report.moved}, removed ${report.removed}, ` +
      `set aside ${report.conflicts} (${report.unchanged} unchanged)`;
    const pushed =
      `Sent: ${report.created} created, ${report.updated} updated, ` +
      `${report.relocated} moved, ${report.deleted} deleted`;
    const attachments =
      report.downloaded + report.uploaded === 0
        ? ''
        : `. Attachments: ${report.downloaded} downloaded, ${report.uploaded} uploaded`;
    const skipped =
      report.skipped === 0
        ? ''
        : report.skipped === 1
          ? '. 1 page could not be placed'
          : `. ${report.skipped} pages could not be placed`;
    const failures =
      report.failures.length === 0
        ? ''
        : report.failures.length === 1
          ? `. 1 failure: ${report.failures[0]}`
          : `. ${report.failures.length} failures: ${report.failures.join(' / ')}`;
    return `${pulled}. ${pushed}${attachments}${skipped}${failures}`;
  },

  signInNotCompleted: (detail) => `Sign-in did not complete: ${detail}`,
  noPendingSignIn: 'No sign-in is in progress. Start again from the settings.',
  signInMismatch: 'The sign-in response did not match the request. Please try again.',
  signInNoCode: 'The sign-in response carried no authorization code.',
  noRefreshToken: 'No refresh token was returned.',
  signInExpired: 'Your sign-in has expired. Please sign in again.',
  configMissing: 'Set the Wiki URL and the client ID first.',
  discoveryUnreachable: (url, detail) => `Could not reach ${url}: ${detail}`,
  discoveryStatus: (url, status) => `${url} returned ${status}. Check the Wiki URL.`,
  discoveryNotJson: (url) => `The response from ${url} is not JSON. Check the Wiki URL.`,
  discoveryNoEndpoints: (url) =>
    `The response from ${url} has no authorization or token endpoint.`,
  tokenRequestFailed: (detail) => `Could not get a token (${detail})`,
  tokenResponseUnexpected: 'The token response was not in the expected shape.',
  webCryptoMissing: 'Web Crypto, which PKCE needs, is not available in this environment.',

  wikiUrlMissing: 'The Wiki URL is not set.',
  pageListUnfinished: (spaceId) => `The page list for space ${spaceId} never ended.`,
  requestRefused: (method, status, detail) =>
    `${method} was refused with ${status}${detail === '' ? '' : `: ${detail}`}`,

  attachmentFailure: (attachmentId, message) => `Attachment ${attachmentId}: ${message}`,
  downloadRefused: (status) => `The download was refused with ${status}`,
  uploadRefused: (status) => `The upload was refused with ${status}`,
  cannotCreateFolder: (path) => `Cannot create ${path}`,
};

/**
 * Obsidian's UI language, or the empty string outside Obsidian.
 *
 * `window` does not exist when this module is bundled for the test run, and
 * reading a missing global throws rather than returning undefined — hence the
 * try, which lands on English there.
 *
 * A key that is present was written by hand and settles the question, including
 * when it holds a language this plugin has no dictionary for. An absent key
 * means Obsidian is following the system, and moment carries the result of that
 * — reading the system locale directly would answer a different question, since
 * it also answers `ja` to somebody who set the app to English on a Japanese Mac.
 */
function readObsidianLanguage(): string {
  try {
    const chosen = window.localStorage.getItem('language');
    if (chosen !== null) return chosen;
  } catch {
    return '';
  }
  return moment.locale();
}

export const t: Messages = readObsidianLanguage().startsWith('ja') ? ja : en;

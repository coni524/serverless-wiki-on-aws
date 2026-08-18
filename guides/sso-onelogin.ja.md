# OneLogin でのサインイン設定

README の SSO 手順のうち、IdP 側の操作を OneLogin の画面で示します（2026 年 8 月に実測）。

## 事前に揃えるもの

- リダイレクト URI の値：スタック出力 `SsoIdpRedirectUri`（SSO 有効化前は `McpSignInDomain` の値 + `/oauth2/idpresponse`）
- アプリを追加できる管理権限

## 1. アプリを追加する

管理画面で「Applications」→「Add App」、「OpenId Connect (OIDC)」を検索して選び、表示名（例: `sl-wiki`）を付けて保存。
「Configuration」タブで 2 つの欄を埋めます。

| 欄 | 値 |
|---|---|
| Login Url | Wiki のオリジン（ポータルのタイルから開く先） |
| Redirect URI's | `https://<プールのサインインドメイン>/oauth2/idpresponse` |

アプリは OneLogin のロールへ割り当てて利用者に配ります。

## 2. 控える値

「SSO」タブで 3 つ控えます。

- **Client ID** → `sso.config.json` のエントリの `clientId`
- **Client Secret** → デプロイより先に Secrets Manager へ
- **Issuer URL**（`https://<サブドメイン>.onelogin.com/oidc/2`）→ エントリの `issuerUrl`

## 3. Token Endpoint を POST にする

同じ「SSO」タブの「Token Endpoint」を、既定の `Basic` から **`POST`** へ変えます。
`Basic` のままだとサインインが「code exchange failed」で落ちます（Cognito は `client_secret_post` しか話しません）。

## 4. ロールをトークンに載せる

「Parameters」タブの「Groups」を開き、値に「User Roles」、複数値の出力に「Semicolon Delimited input (Multi-value output)」を選びます。
あわせてデプロイ時にスコープへ `groups` を足します（手順 5）。要求しないと OneLogin はクレームを返しません。

## 5. デプロイと対応づけ

以降は README の手順 3 のとおりです。OneLogin 固有は、スコープに `groups` を足す 1 点です。
リポジトリルートの `sso.config.json` にエントリを書き、`pnpm run deploy` を実行します。

```json
{
  "idps": [
    {
      "name": "sso",
      "label": "OneLogin",
      "issuerUrl": "https://<サブドメイン>.onelogin.com/oidc/2",
      "clientId": "<控えたクライアント ID>",
      "scopes": ["openid", "email", "profile", "groups"]
    }
  ]
}
```

サインインボタンの表示名はエントリの `label` で変えます。
2 つ目の IdP として足すときは、`idps` 配列に同じ形のエントリを足します（名前は他のエントリと重ならないものにします）。
2 件目以降のシークレットの既定名は `<スタック名>-sl-wiki-sso-idp-<名前>-client-secret` です。

管理画面の「ロールグループ」の対応づけに入れる値は、**ロールの名前そのもの**です（Entra のような GUID ではありません）。
日本語のロール名もそのまま入れます（Cognito のパーセントエンコードは Wiki が復号します）。

## 運用の注意

- 連携利用者の MFA（多要素認証）は OneLogin のセキュリティポリシーで掛けます。プールの MFA 必須設定はパスワードのアカウントにだけ効きます
- OneLogin 側のロール変更が Wiki に届くのは次回サインイン時です。確認はプライベートウィンドウで

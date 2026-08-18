# Microsoft Entra ID でのサインイン設定

README の SSO 手順のうち、IdP 側の操作を Entra ID の画面で示します（2026 年 8 月に実測）。

## 事前に揃えるもの

- リダイレクト URI の値：スタック出力 `SsoIdpRedirectUri`（SSO 有効化前は `McpSignInDomain` の値 + `/oauth2/idpresponse`）
- アプリを登録できるロール（アプリケーション開発者以上）

## 1. アプリを登録する

[entra.microsoft.com](https://entra.microsoft.com) で「ID」→「アプリケーション」→「アプリの登録」→「新規登録」。

| 項目 | 値 |
|---|---|
| 名前 | 任意（例: `sl-wiki`） |
| サポートされているアカウントの種類 | この組織ディレクトリのみに含まれるアカウント（シングルテナント） |
| リダイレクト URI | プラットフォーム「Web」、値 `https://<プールのサインインドメイン>/oauth2/idpresponse` |

## 2. 控える値

「概要」ページで 2 つ控えます。

- **アプリケーション (クライアント) ID** → `sso.config.json` のエントリの `clientId`
- **ディレクトリ (テナント) ID** → 発行者 URL `https://login.microsoftonline.com/<テナント ID>/v2.0` を組み立てて、エントリの `issuerUrl`

スコープとクレーム名は Wiki の既定のままで通ります。

## 3. グループをトークンに載せる

「トークン構成」→「グループ要求の追加」で、グループの要求を **ID トークン**に追加します。
送るグループは「アプリケーションに割り当てられているグループ」を選び、「エンタープライズ アプリケーション」側で利用者のグループをこのアプリへ割り当てます。
グループの割り当てができないテナントでは「セキュリティ グループ」でも動きます。
受け皿の属性は 2048 文字（GUID 約 50 個）で、溢れた利用者には権限が付きません。

## 4. クライアントシークレットを作る

「証明書とシークレット」→「新しいクライアント シークレット」で作成し、「値」の列を控えます。
表示は作成直後だけです。「シークレット ID」の列ではありません。

### 作成ボタンがポリシーでブロックされているとき

[Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) で次の 2 リクエストを順に実行すると、このアプリだけ例外にできます（権限 `Policy.ReadWrite.ApplicationConfiguration` への同意を求められます）。

```
POST https://graph.microsoft.com/v1.0/policies/appManagementPolicies

{ "displayName": "Allow client secret for sl-wiki",
  "isEnabled": true,
  "restrictions": { "passwordCredentials": [] } }
```

応答の `id` を控えて、アプリへ割り当てます。
`<アプリのオブジェクト ID>` は「概要」ページの「オブジェクト ID」です（クライアント ID とは別の値）。

```
POST https://graph.microsoft.com/v1.0/applications/<アプリのオブジェクト ID>/appManagementPolicies/$ref

{ "@odata.id": "https://graph.microsoft.com/v1.0/policies/appManagementPolicies/<控えた id>" }
```

## 5. デプロイと対応づけ

以降は README の手順 3 のとおりです。
リポジトリルートの `sso.config.json` にエントリを書き、`pnpm run deploy` を実行します。

```json
{
  "idps": [
    {
      "name": "sso",
      "label": "Entra",
      "issuerUrl": "https://login.microsoftonline.com/<テナント ID>/v2.0",
      "clientId": "<控えたクライアント ID>"
    }
  ]
}
```

サインインボタンの表示名はエントリの `label` で変えます。
2 つ目の IdP として足すときは、`idps` 配列に同じ形のエントリを足します（名前は他のエントリと重ならないものにします）。
2 件目以降のシークレットの既定名は `<スタック名>-sl-wiki-sso-idp-<名前>-client-secret` です。

管理画面の「ロールグループ」の対応づけに入れる値は、グループの**オブジェクト ID** です（表示名ではありません。「グループ」一覧で確認）。

## 運用の注意

- 連携利用者の MFA（多要素認証）は Entra の条件付きアクセスで掛けます。プールの MFA 必須設定はパスワードのアカウントにだけ効きます
- Entra 側のグループ変更が Wiki に届くのは、数分後の次回サインイン時です。確認はプライベートウィンドウで

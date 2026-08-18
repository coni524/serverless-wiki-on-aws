# serverless-wiki-on-aws

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node%2Ejs-24-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-Serverless-232F3E?logo=amazonwebservices&logoColor=white)

[English](README.md) | **日本語**

AWSで動く Markdown の Wiki です。
ブラウザーの画面、Amazon Bedrock の AI アシスタント、MCP（Model Context Protocol、AI クライアントとツールを接続する標準プロトコル）のクライアント、Obsidian（ローカルの Markdown ノートアプリ）の同期プラグインは、どれも同じページを読み書きし、API 層がリクエストごとに行う同じ権限判定を通ります。

デプロイするのは Lambda、API Gateway、DynamoDB、S3、CloudFront、Cognito、SQS、Bedrock です。

![ページの閲覧画面。左にスペースのフォルダーとページの木構造、右に Markdown を描画した本文が並ぶ](assets/screenshot-page-ja.png)

*ページを読んでいるところです。*

## 設計思想

- 動作もデータの保管も、運用者の AWS アカウントの中で完結します
- 常時稼働で常時課金されるリソースはありません
- ローカルの Obsidian と双方向に同期します
- Bedrock の AI アシスタントと MCP サーバーは、画面と同じ権限判定を通ります
- AWS Blocks で構築しています

## 機能

- Markdown のページを、スペースごとのフォルダーとページの木構造で整理します
- スペース単位の権限を、API 層がリクエストごとに判定します
- サインインは Cognito に登録したメールアドレスとパスワードで行い、すべてのアカウントに TOTP（Time-based One-Time Password、認証アプリが出す時限式のワンタイムパスワード）の MFA（多要素認証）を必須にします。利用者が自分でサインアップすることはできず、運用者がアカウントを作ります。自分の権限を上げる API はありません
- IdP（Identity Provider、認証情報の提供元）でのサインインにも対応します。OIDC（OpenID Connect）に対応した IdP（Okta、OneLogin、Auth0、Microsoft Entra、Keycloak など）なら、どれも同じ設定でつながります。IdP のグループをロールグループに対応づけると、サインインのたびに権限が IdP のグループに合わせて更新されます。パスワードでのサインインと併用できます
- Amazon Bedrock の AI アシスタントが Wiki を検索し、見つけた内容から答え、利用者が承認したときだけページを書き換えます。既定のモデルは Amazon Nova 2 Lite で、環境変数 `AI_MODEL_ID` で別の Bedrock のモデルに変更できます
- 検索窓は 1 つで、2 通りの検索を融合します。スペースごとの転置インデックス（語からその語を含む文書の一覧を引く索引）を BM25（語の珍しさと出現回数から重要度を出す式）で順位付けして完全一致の語や識別子を引き、Bedrock Knowledge Bases と S3 Vectors（ベクトル検索用のストレージ）と Titan Text Embeddings V2 が意味の近いページを引き、両方の順位を RRF（Reciprocal Rank Fusion、順位の逆数を足し合わせて 1 つに融合する手法）で並べ直します。結果にはヒット箇所の抜粋が付き、入力の途中でサジェストが出ます
- `POST /mcp` の MCP サーバーが、Cognito を認可サーバーとする OAuth 2.1 の認証で、Claude などの MCP クライアントからの接続を受け付けます
- Obsidian の保管庫とスペースを双方向に同期するプラグインを同梱しています
- 添付ファイルは presigned URL（署名付き URL、短時間だけ有効なリンク）で配信します。バケットはパブリックアクセスを全面ブロックします
- 画面はヘッダーで日本語と英語を切り替えられます
- インフラは [AWS Blocks](https://www.npmjs.com/package/@aws-blocks/blocks)（Infrastructure-from-Code のフレームワーク）で定義します

## 構成図

![構成図。CloudFront と S3 が SPA を配信し、API Gateway がブラウザ・MCP・同期クライアントの呼び出しを 1 つの Lambda へ渡す。Lambda が DynamoDB で権限を判定し、本文と添付を S3 に置き、検索と AI 応答で Bedrock を呼ぶ](assets/architecture.png)

*実線の矢印は同期のリクエスト経路を、破線の矢印は非同期の処理の流れを表します。*

## 画面

![スペースの一覧。カード 1 枚が 1 つのスペースで、サインイン中のアカウントが持つ権限を各カードが示す](assets/screenshot-spaces-ja.png)

*スペースの一覧です。カードのバッジは、サインイン中のアカウントがそのスペースに持つ権限を表します。*

![検索結果。カード 1 枚が 1 ページで、所属スペースと本文の抜粋を並べる](assets/screenshot-search-ja.png)

*検索の結果です。*

![ページの閲覧画面の右に AI アシスタントの欄が開き、質問への回答を表示している](assets/screenshot-ai-ask.png)

*AI アシスタントに質問したところです。*

![変更の確認画面。新しいページの Markdown 全体を追加行の差分として表示し、AI アシスタントの欄に承認と破棄のボタンが並ぶ](assets/screenshot-ai-create.png)

*AI アシスタントにページの作成を頼んだところです。利用者が承認するまで、AI アシスタントは Wiki に書き込みません。*

![変更の確認画面。本文全体の中で、削除する行を赤、置き換える行を緑で示し、変わった文字をハイライトする](assets/screenshot-ai-diff.png)

*既存ページの編集は、承認の前に差分で確かめられます。*

## 前提

- [Node.js 24](https://nodejs.org/) と [pnpm 11](https://pnpm.io/)（npm は使いません。`mise install` が `mise.toml` から両方を入れます）
- デプロイする場合は、AWS アカウント、[AWS CLI 2.32.0 以上](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)、Amazon Nova 2 Lite と Titan Text Embeddings V2 に対する Bedrock のモデルアクセス
- CloudFormation のスタックは、AWS CLI のプロファイルに設定されたリージョンへデプロイされます。動作を確認済みなのは `ap-northeast-1`（東京）です。どのリージョンでも、S3 Vectors と上の 2 つの Bedrock のモデルが使える必要があります

## すぐ試す

AWS アカウントは要りません。
すべての Building Block が手元でモックとして動き、モックのデータは `.bb-data/` に置かれます。

```bash
pnpm install
pnpm run dev
```

**ブラウザで開く：**[http://localhost:3000](http://localhost:3000)

モックはサインアップを受け付けるので、その画面でアカウントを作ってサインインします。
権限の判定は本番と同じに動くため、作ったばかりのアカウントはどのグループにも属さず、スペースが 1 つも見えません。
デプロイ後と同じ手順で自分を管理者にします。
データの保存先ファイルを開発サーバーが書き換えるため、先にサーバーを止めます。

```bash
# 開発サーバーを Ctrl-C で止めてから
pnpm run seed-admin -- --local --email you@example.test
pnpm run dev
```

AI アシスタントだけは模擬モデルにつながっており、決まった文面を返します。

## AWS へデプロイする

```bash
aws login --profile <プロファイル名>
pnpm run deploy
```

初回のデプロイは 2 回実行され、2 回目は `pnpm run deploy` が自動で行います。
1 回目で作られる CloudFront のアドレスを、Lambda の環境変数に設定するためです。
アドレスが既にある場合、デプロイは 1 回で終わります。

### 最初のアカウントを作る

最初のアカウントは、運用者が Cognito のユーザープールに作ります。
パスワードは 12 文字以上で、大文字・小文字・数字・記号を各 1 つ以上含む必要があります。

```bash
# 名前がスタック ID で始まるプールが対象
aws cognito-idp list-user-pools --max-results 10 --profile <プロファイル名> --region <リージョン>

aws cognito-idp admin-create-user \
  --user-pool-id <ユーザープール ID> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --profile <プロファイル名> --region <リージョン>

# 初回サインインでパスワード変更を求められないよう、恒久的なパスワードとして設定する
aws cognito-idp admin-set-user-password \
  --user-pool-id <ユーザープール ID> \
  --username you@example.com \
  --password '<パスワード>' \
  --permanent \
  --profile <プロファイル名> --region <リージョン>
```

ユーザープールは MFA を必須にしており、方式は TOTP だけです。
そのため、運用者がブラウザーで最初にサインインすると、認証アプリの登録画面が出ます。
運用者は表示された QR コードを認証アプリで読み取り、そのアプリが出す 6 桁のコードを入力します。
2 回目以降のサインインは、コードの入力だけを求めます。

### 最初の管理者を作る

運用者はブラウザで一度サインインします。
このサインインで利用者のプロフィールが作られ、次の手順で使う Cognito の `sub`（利用者の識別子）が確定します。
続いて権限テーブル（名前はスタック ID で始まり `-permissions` で終わります）に、自分を管理者として登録します。

```bash
aws dynamodb list-tables --profile <プロファイル名> --region <リージョン>
AWS_PROFILE=<プロファイル名> pnpm run seed-admin -- --table <テーブル名> --email you@example.com
```

2 人目以降の管理者は、最初の管理者が管理画面から追加します。

### sandbox

`pnpm run sandbox` は、バックエンドを AWS に置き、フロントエンドを手元で動かします。
フロントエンドのオリジンは自動では設定されないため、環境変数で指定します。

```bash
CORS_ALLOWED_ORIGINS=http://localhost:3000 pnpm run sandbox
```

### 撤去する

```bash
pnpm run sandbox:destroy   # sandbox のスタックを、データごと消します
pnpm run destroy           # デプロイしたスタックを消します
```

`pnpm run sandbox:destroy` は、テーブルもバケットもスタックと一緒に消します。
`pnpm run destroy` は、DynamoDB のテーブル、本文と添付のバケット、検索コーパスのバケットを残す設定です。
残っているあいだは保存の料金がかかります。消すときは運用者が手動で削除します。

## 設定

| 環境変数 | 既定 | 役割 |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `pnpm run deploy` がスタックの出力から読みます | S3 のバケットが presigned URL の要求を受け付けるオリジンの一覧（カンマ区切り）です。一致するものが無いと、ブラウザからの添付ファイルの操作が失敗します。カスタムドメインを使っているときと、配信オリジンが複数あるときは、明示的に指定します。ワイルドカードは受け付けません |
| `MCP_PUBLIC_ORIGIN` | `pnpm run deploy` がスタックの出力から読みます | MCP の OAuth メタデータが公示するオリジンです。カスタムドメインのときは明示的に指定します |
| `AI_MODEL_ID` | `global.amazon.nova-2-lite-v1:0` | AI アシスタントが呼ぶ Bedrock のモデルです。既定は Amazon Nova 2 Lite の Global 推論プロファイル（リクエストを対応リージョンへ振り分ける定義）です。`jp.amazon.nova-2-lite-v1:0` は推論を日本国内のリージョンに限定し、`global.anthropic.claude-sonnet-4-6` と `global.anthropic.claude-sonnet-5` はツール選択の精度が上がり料金も上がります。どのモデルも、Bedrock 側でモデルアクセスを先に有効にする必要があります（この環境変数はアクセス権を与えません）。未設定や空文字のときはエラーにならず、既定値が使われます |

### IdP でサインインできるようにする

OIDC に対応した IdP なら、設定する内容はどれも同じです。
Microsoft Entra ID の画面操作は付録 [`guides/sso-entra-id.ja.md`](guides/sso-entra-id.ja.md) に、OneLogin は付録 [`guides/sso-onelogin.ja.md`](guides/sso-onelogin.ja.md) にあります。
IdP は Wiki 自身の Cognito ユーザープールに登録するため、連携の利用者もプールのユーザーになります。識別子は全員がプールの `sub` に統一され、連携の利用者も MCP と同期 API をそのまま使えます。

IdP の設定は、リポジトリルートの設定ファイル `sso.config.json` に書きます。ファイルが無ければ SSO は構成されず、サインイン画面にはパスワードの欄だけが表示されます。ファイルにはテナント ID とクライアント ID が載ります（クライアントシークレットは載せません）。コミットするのは非公開のクローンだけにしてください。

1. IdP 側に OIDC の Web アプリケーションを 1 つ作ります。リダイレクト URI は `https://<プールのサインインドメイン>/oauth2/idpresponse`（スタック出力 `SsoIdpRedirectUri` の値。SSO 有効化前なら `McpSignInDomain` に `/oauth2/idpresponse` を付けた値と同じです）、スコープは `openid email profile`、付与タイプは認可コードです
2. **利用者のグループを ID トークンのクレーム（トークンに載る属性）へ載せる設定を、IdP 側で有効にし、送るのは「このアプリに割り当てたグループだけ」にします。** クレームは既定で送らない IdP が多く、忘れると誰にも権限が付きません。絞り忘れると、グループの多い利用者ではグループを受け取る Cognito の属性（最大 2048 文字）が溢れ、やはり権限が付きません
3. IdP のクライアントシークレットを、デプロイより先に Secrets Manager へ入れます（デプロイ時に CloudFormation が読みます。シークレット 1 件あたり月 0.40 USD かかります）

   ```bash
   aws secretsmanager create-secret --name '<スタック名>-sl-wiki-sso-idp-client-secret' \
     --secret-string '<クライアントシークレット>'
   ```

4. `sso.config.json` を書いてデプロイします。SSO を初めて有効にするデプロイは、自動で 2 回実行されます

   ```json
   {
     "idps": [
       {
         "name": "sso",
         "issuerUrl": "https://<IdP の発行者 URL>",
         "clientId": "<IdP のクライアント ID>"
       }
     ]
   }
   ```

   エントリの任意フィールドは `label`（サインインボタンの表示名）、`groupsClaim`（既定 `groups`）、`scopes`（既定 `openid email profile`。Okta と OneLogin はグループを載せるのに `groups` を足します）、`secretName`（シークレットを既定と別の名前で作ったとき）、`registrationName`（Cognito がこの IdP を呼ぶ名前。連携ユーザー名の接頭辞になるため、あとから変えると別のアカウントとして扱われます）です。独自ドメインを使うときは、トップレベルの `callbackOrigins` 配列で戻り先のオリジンを書きます。

5. 管理画面の「ロールグループ」を開き、「外部 IdP のグループとの対応」に、どの IdP かと、クレームに載るグループの識別子（Entra ならグループの表示名ではなくオブジェクト ID、OneLogin ならロールの名前）を行で入れます

IdP は複数登録できます。2 件目以降は `idps` 配列にエントリを足します。配列の並び順がサインインボタンの並び順になり、`name` が IdP を識別します。プールには IdP ごとに登録とクライアントの組ができ、サインイン画面には IdP ごとのボタンが並びます。

ファイルからエントリを消してデプロイすると、デプロイスクリプトがプールの登録済み IdP と突き合わせ、エラーで停止します（編集ミスで連携サインインが壊れないようにするためです）。削除する意図があるときは `SSO_REMOVE=<名前>` を付けて実行します（改名は旧名の削除として扱います。全削除は `SSO_REMOVE=true` です）。

> **フェデレーションの利用者の権限は、IdP 側で調整してください。**
> サインインのたびに、Wiki はその利用者のロールグループを IdP のクレームどおりに書き換えます（無いものは消します）。
> そのため Wiki の管理画面から変えても、次のサインインで消えます。画面もその割り当ては読み取り専用で見せます。
> IdP 側でグループから外しても、Wiki に反映されるのは次回のサインイン時です。すぐに止めたいときは、IdP 側でその利用者のサインインを止めてください。
> 一方、Wiki 側で対応づけそのものを消すと、対応づけられていた利用者全員からその場で権限が外れます。

パスワードでのサインインは無効になりません。IdP の設定を誤ったときに、設定を直しに入る手段を残すためです。
プールの MFA（多要素認証）必須の設定はパスワードのアカウントにだけ効くので、連携の利用者の MFA は IdP 側で設定します（Entra なら条件付きアクセス）。
同じメールアドレスでも、パスワードのアカウントと IdP のアカウントは別ユーザーで、権限も別々に付きます。

SAML には対応しません。

### MCP クライアントに登録する

`.mcp.json.example` を `.mcp.json` に写し、CloudFront のドメインと、スタック出力 `McpClientId` の値を埋めます。

```bash
aws cloudformation describe-stacks --stack-name <スタック名> --profile <プロファイル名> \
  --query 'Stacks[0].Outputs[?OutputKey==`McpClientId`].OutputValue' --output text
```

### Obsidian と同期する

同梱のプラグイン `clients/obsidian/` が、Obsidian の保管庫と、利用者が読めるスペースを同期します。
両者が食い違ったときは Wiki の内容を優先し、プラグインが手元のファイルを退避してから Wiki の内容で上書きします。
導入と利用の手順は [clients/obsidian/README.ja.md](clients/obsidian/README.ja.md) にあります。

## ディレクトリ構成

```
serverless-wiki-on-aws/
├── aws-blocks/           # バックエンド
│   ├── index.cdk.ts      # CDK アプリ（Building Block の宣言は resources.ts）
│   ├── index.ts          # フロントエンドが呼ぶ API
│   ├── access.ts         # 権限判定
│   ├── wiki-ops.ts       # ページ、ツリー、検索の操作
│   ├── keyword-index.ts  # 転置インデックスの構築、検索、サジェスト
│   ├── mcp.ts            # MCP サーバー（POST /mcp）
│   ├── ext.ts            # 同期クライアント向け API（POST /ext/*）
│   └── scripts/          # deploy、sandbox、seed-admin、destroy
├── src/                  # フロントエンド（React 19 + Vite + Cloudscape）
│   ├── app/              # ルーティング、プロバイダー、画面の外枠
│   ├── features/         # spaces、pages、search、assistant、auth、admin
│   ├── components/       # feature をまたいで使う UI 部品
│   └── lib/              # Markdown、差分、ルーター、TanStack Query、日英の辞書
├── clients/obsidian/     # Obsidian 同期プラグイン
├── test/                 # API 全体を通す E2E テストと、単体テスト
├── assets/               # この文書に載せる画面の画像と構成図
└── README.md             # 英語版のこの文書
```

## 制約

- **保存したページが検索に出るまで、少し時間がかかります。** 索引を作り直すジョブが保存の 30 秒後に動き、意味検索の索引はさらに全ページを読み直すためです。
- **日本語のキーワード検索は、まれに無関係なページに一致します。** 形態素解析器（辞書を持ち文を単語に分ける解析器）を使わず、本文を 2 文字ずつの並び（bigram）で索引にしているため、同じ 2 文字の並びを含むだけのページも一致します。
- **本文の中の生の HTML は描画しません。** Markdown は CommonMark（Markdown の標準仕様）に GFM（GitHub Flavored Markdown、GitHub 方言）の表・タスクリスト・取り消し線を足した範囲を描画し、1 つだけの改行も改行として扱いますが、本文に書いた HTML タグは解釈せず、文字のまま表示します。画像として埋め込めるのはそのページ自身の添付だけで、それ以外の画像はリンクとして表示します。検索結果の抜粋は Markdown を解釈せず、記法を記号のまま表示します。
- **最初のアカウントの作成には AWS CLI の操作が必要です。** デプロイ直後に、運用者が AWS CLI で Cognito にアカウントを作り、一度サインインしてから `pnpm run seed-admin` を実行します。
- **監査ログと、API のレートリミット（呼び出し回数の制限）はありません。**

## 参考

- [AWS Blocks](https://www.npmjs.com/package/@aws-blocks/blocks)：このプロジェクトの実装基盤
- [Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)：意味検索の基盤
- [Model Context Protocol](https://modelcontextprotocol.io/)：`/mcp` エンドポイントのプロトコル
- [Cloudscape Design System](https://cloudscape.design/)：画面に使っている UI 部品のデザインシステム

## ライセンス

[MIT License](LICENSE)

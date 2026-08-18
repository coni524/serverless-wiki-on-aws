# serverless-wiki-on-aws

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node%2Ejs-24-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-Serverless-232F3E?logo=amazonwebservices&logoColor=white)

**English** | [日本語](README.ja.md)

A Markdown wiki that runs on AWS. The browser UI, the Amazon Bedrock assistant, MCP clients, and the Obsidian sync plugin read and write the same pages through the same space permission check, resolved in the API layer on every request.

The deployed stack is Lambda, API Gateway, DynamoDB, S3, CloudFront, Cognito, SQS, and Bedrock.

![A page in the wiki: the folder-and-page tree of the space on the left, the rendered Markdown on the right](assets/screenshot-page.png)

*Reading a page.*

## Design principles

- Everything runs and stores its data inside the operator's own AWS account
- There are no always-on, always-billing resources
- It syncs both ways with Obsidian on your machine
- The Bedrock assistant and the MCP server go through the same permission check as the UI
- Built with AWS Blocks

## Features

- Markdown pages arranged in a folder-and-page tree, one tree per space
- Space-level permissions resolved on every request in the API layer
- Sign-in is a Cognito email address, and TOTP multi-factor authentication is required of every account. Sign-up is closed: an operator creates accounts, and no API raises anyone's own permissions
- Sign-in through an identity provider (IdP) as well. Any OIDC provider works from the same settings — Okta, OneLogin, Auth0, Microsoft Entra, Keycloak. Map an IdP group to a role group and permissions are updated to match the IdP's groups on every sign-in. Password sign-in keeps working alongside it
- AI assistant on Amazon Bedrock: it searches the wiki, answers from what it finds, and edits pages only after you approve the change. The default model is Amazon Nova 2 Lite; set `AI_MODEL_ID` to use another Bedrock model
- Hybrid search in one box: an inverted index per space, ranked with BM25, finds exact keywords and identifiers; Bedrock Knowledge Bases with S3 Vectors and Titan Text Embeddings V2 finds meaning; the two rankings are fused with Reciprocal Rank Fusion. Results carry a highlighted excerpt, and suggestions appear as you type
- MCP (Model Context Protocol) server at `POST /mcp`, authenticated with OAuth 2.1 through Cognito, for Claude and other MCP clients
- Obsidian plugin that syncs a vault and a space in both directions
- Attachments delivered through presigned URLs; the bucket blocks all public access
- Japanese and English UI, switched in the header
- Infrastructure defined with [AWS Blocks](https://www.npmjs.com/package/@aws-blocks/blocks), an Infrastructure-from-Code framework

## Architecture

![Architecture diagram: CloudFront and S3 serve the SPA; API Gateway routes browser, MCP, and sync calls to one Lambda; the Lambda checks permissions in DynamoDB, stores pages and attachments in S3, and talks to Bedrock for search and AI replies](assets/architecture.png)

*Solid arrows are the request path; dashed arrows are asynchronous or background flows.*

## Screens

![The space list, one card per space, each showing the permission the signed-in account holds](assets/screenshot-spaces.png)

*The space list. The badge on each card is the permission the signed-in account holds on that space.*

![Search results, one card per page, each showing the space it belongs to and a matching excerpt](assets/screenshot-search.png)

*Search results.*

![A page with the AI assistant open on the right, answering a question from the page content](assets/screenshot-ai-ask.png)

*Asking the AI assistant a question.*

![The review-change view: the Markdown of a new page shown as an all-added diff, with an approval prompt in the assistant panel](assets/screenshot-ai-create.png)

*Asking the assistant to create a page. Nothing is written to the wiki until you approve the change.*

![The review-change view: within the full page body, the removed line in red and the replacement line in green, with the changed characters highlighted](assets/screenshot-ai-diff.png)

*An edit to an existing page appears as a diff before approval.*

## Prerequisites

- [Node.js 24](https://nodejs.org/) and [pnpm 11](https://pnpm.io/) (npm is not supported; `mise install` picks up both from `mise.toml`)
- To deploy: an AWS account, [AWS CLI 2.32.0+](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), and Bedrock model access for Amazon Nova 2 Lite and Titan Text Embeddings V2
- The CloudFormation stack deploys to the region your AWS CLI profile specifies. It has been tested in `ap-northeast-1` (Tokyo); the region you pick must offer S3 Vectors and the two Bedrock models above

## Quick Start

No AWS account is needed. Every Building Block runs mocked on your machine, and the mock data lands in `.bb-data/`.

```bash
pnpm install
pnpm run dev
```

**Open your browser:** Navigate to [http://localhost:3000](http://localhost:3000).

The local mock accepts sign-up, so create an account on that screen and sign in. Permission checks work as in production, so a brand-new account belongs to no group and sees no spaces. Make yourself an administrator the same way a real deployment does. The dev server rewrites the local data file, so stop it first.

```bash
# Ctrl-C the dev server, then
pnpm run seed-admin -- --local --email you@example.test
pnpm run dev
```

Only the assistant differs: it talks to a mock model that replies with fixed text.

## Deploy to AWS

```bash
aws login --profile <profile>
pnpm run deploy
```

The first deploy runs twice, and `pnpm run deploy` runs the second pass itself: it sets the CloudFront address created by the first pass into the Lambda's environment variables. Once the address exists, a deploy runs once.

### The first account

Create the first account yourself in the Cognito user pool. The password has to be 12 characters or longer and carry an upper-case letter, a lower-case letter, a digit, and a symbol.

```bash
# The pool whose name starts with your stack id
aws cognito-idp list-user-pools --max-results 10 --profile <profile> --region <region>

aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --profile <profile> --region <region>

# Set the password permanently, so the first sign-in is not a password-change challenge
aws cognito-idp admin-set-user-password \
  --user-pool-id <user-pool-id> \
  --username you@example.com \
  --password '<password>' \
  --permanent \
  --profile <profile> --region <region>
```

The pool requires MFA and offers TOTP as the only factor, so the first sign-in in the browser presents an enrolment challenge: scan the QR code with an authenticator app and enter the six-digit code it shows. Every later sign-in asks for a code.

### The first administrator

Sign in once in the browser first. That sign-in creates your profile record and determines the Cognito `sub` (your user identifier) the next step uses. Then register yourself as an administrator in the permission table — its name starts with the stack id and ends in `-permissions`.

```bash
aws dynamodb list-tables --profile <profile> --region <region>
AWS_PROFILE=<profile> pnpm run seed-admin -- --table <table-name> --email you@example.com
```

Every administrator after the first one is added by an administrator, from the admin screens.

### Sandbox

`pnpm run sandbox` puts the backend on AWS and leaves the frontend on your machine. The frontend origin is not set automatically, so pass it as an environment variable.

```bash
CORS_ALLOWED_ORIGINS=http://localhost:3000 pnpm run sandbox
```

### Teardown

```bash
pnpm run sandbox:destroy   # the sandbox stack, data and all
pnpm run destroy           # the deployed stack
```

`pnpm run sandbox:destroy` deletes the tables and buckets together with the stack. `pnpm run destroy` keeps the DynamoDB table, the content bucket, and the search corpus bucket. They bill for storage until the operator deletes them manually.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | read from the stack output by `pnpm run deploy` | Comma-separated origins the S3 bucket accepts presigned-URL requests from. Without a match, attachments fail in the browser. Set it explicitly when a custom domain sits in front of CloudFront or several origins serve the app. Wildcards are rejected. |
| `MCP_PUBLIC_ORIGIN` | read from the stack output by `pnpm run deploy` | The origin the MCP OAuth metadata advertises. Set it explicitly for a custom domain. |
| `AI_MODEL_ID` | `global.amazon.nova-2-lite-v1:0` | The Bedrock model the assistant talks to. Amazon Nova 2 Lite through its Global inference profile is the default. `jp.amazon.nova-2-lite-v1:0` keeps inference inside Japan; `global.anthropic.claude-sonnet-4-6` and `global.anthropic.claude-sonnet-5` select tools better and cost more. Whichever you name, enable model access for it in Bedrock first — passing the variable does not grant it. Read at run time, so an unset or empty value falls back to the default rather than failing. |

### Signing in with your identity provider

The settings are the same for every OIDC provider.
For Microsoft Entra ID, the appendix [`guides/sso-entra-id.md`](guides/sso-entra-id.md) walks through the actual screens; [`guides/sso-onelogin.md`](guides/sso-onelogin.md) does the same for OneLogin. The IdP is registered on the wiki's own Cognito user pool, so federated users become pool users too: everyone is identified by the pool's `sub`, and federated users can use MCP and the sync API as well.

The IdP entries live in a config file, `sso.config.json`, at the repository root. Without the file, SSO is not set up and the sign-in screen shows only the password form. The file carries your tenant and client IDs (never the client secret), so commit it to private clones only.

1. Create one OIDC web application at your IdP. Redirect URI `https://<pool sign-in domain>/oauth2/idpresponse` (the `SsoIdpRedirectUri` stack output; before SSO is enabled, `McpSignInDomain` + `/oauth2/idpresponse` is the same value), scopes `openid email profile`, authorization-code grant.
2. **Turn on the setting that puts the user's groups into the ID token as a claim**, and limit it to the groups assigned to this app. Most providers leave the claim off, and without it a sign-in succeeds but grants no permissions; without the limit, a user in many groups overflows the Cognito attribute that receives them (2048 characters) and also gets no permissions.
3. Put the IdP's client secret into Secrets Manager before deploying — CloudFormation reads it from there (one secret, $0.40/month while SSO is on):

   ```bash
   aws secretsmanager create-secret --name '<stack-name>-sl-wiki-sso-idp-client-secret' \
     --secret-string '<client secret>'
   ```

4. Write `sso.config.json` and deploy. The first SSO deploy runs a second pass by itself:

   ```json
   {
     "idps": [
       {
         "name": "sso",
         "issuerUrl": "https://<your issuer URL>",
         "clientId": "<your client id>"
       }
     ]
   }
   ```

   Optional entry fields: `label` (the sign-in button's text), `groupsClaim` (default `groups`), `scopes` (default `openid email profile` — Okta and OneLogin want `groups` added before they put groups in the token), `secretName` (when the secret is not under the default name), and `registrationName` (the name Cognito knows the IdP by; it prefixes federated usernames, so changing it later orphans those accounts). A top-level `callbackOrigins` array overrides the resolved origin when a custom domain sits in front.

5. In the admin screens, open a role group and fill in "Mapping to external IdP groups" with rows naming which IdP and the group's identifier as it appears in the claim (for Entra that is the group's object ID, not its display name; for OneLogin, the role's name).

More than one IdP can be registered: add entries to the `idps` array (the array order sets the button order; `name` identifies the IdP). The pool gets a registration and app client per IdP, and the sign-in screen draws one button per IdP.

Removing an entry from the file is guarded: the deploy script compares the file against the pool's registrations and stops if one would disappear, so an editing mistake cannot break federated sign-in. Confirm a deliberate removal with `SSO_REMOVE=<name>` (a rename counts as removing the old name), or `SSO_REMOVE=true` to remove them all.

> **Adjust a federated user's permissions at the identity provider.**
> Every sign-in rewrites that user's role groups to match the IdP's claims, removing any the claims no longer name. An edit made in the wiki's admin screens is undone by their next sign-in, which is why those screens show the assignment read-only.
> Removing someone from a group at the IdP reaches the wiki at their next sign-in, so to cut them off immediately, stop their sign-in at the IdP. Clearing the mapping in the wiki, by contrast, disconnects everyone on it at once.

Password sign-in stays enabled, so a misconfigured IdP does not lock out the person who has to fix it. The pool's MFA requirement applies to password accounts only; require MFA for federated users at the IdP (conditional access, in Entra's terms). A password account and a federated account with the same email address are separate users with separate permissions.

SAML is not supported.

### MCP clients

Copy `.mcp.json.example` to `.mcp.json` and fill in the CloudFront domain and the `McpClientId` stack output.

```bash
aws cloudformation describe-stacks --stack-name <stack-name> --profile <profile> \
  --query 'Stacks[0].Outputs[?OutputKey==`McpClientId`].OutputValue' --output text
```

### Obsidian sync

The bundled plugin in `clients/obsidian/` syncs an Obsidian vault with the spaces you can read. When the two sides disagree, the wiki's version takes precedence: the plugin backs up your local copy, then overwrites it with the wiki's version. Setup and usage are in [clients/obsidian/README.md](clients/obsidian/README.md).

## Project Structure

```
serverless-wiki-on-aws/
├── aws-blocks/           # Backend
│   ├── index.cdk.ts      # CDK app; resources.ts declares the Building Blocks
│   ├── index.ts          # API surface the frontend calls
│   ├── access.ts         # Permission resolution
│   ├── wiki-ops.ts       # Page, tree, and search operations
│   ├── keyword-index.ts  # Inverted index: rebuild, search, suggest
│   ├── mcp.ts            # MCP server (POST /mcp)
│   ├── ext.ts            # Sync-client API (POST /ext/*)
│   └── scripts/          # deploy, sandbox, seed-admin, destroy
├── src/                  # Frontend (React 19 + Vite + Cloudscape)
│   ├── app/              # Routes, providers, and the app shell
│   ├── features/         # spaces, pages, search, assistant, auth, admin
│   ├── components/       # UI shared across features
│   └── lib/              # Markdown, diff, router, TanStack Query, i18n dictionaries
├── clients/obsidian/     # Obsidian sync plugin
├── test/                 # End-to-end test across the whole API, and unit tests
├── assets/               # Screenshots and the architecture diagram used by this README
└── README.md             # This file
```

## Limitations

- **A page you just saved takes a while to appear in search.** The index-rebuild job runs 30 seconds after a save, and the semantic index additionally re-reads every page.
- **Japanese keyword search occasionally matches unrelated pages.** The body is indexed as two-character sequences (bigrams) instead of through a morphological analyzer, so a page that merely contains the same character pair can match.
- **Raw HTML in a body is not rendered.** Markdown is CommonMark plus GFM — tables, task lists, strikethrough — and a single newline is a line break, but a body's own HTML tags are shown as text rather than parsed. A page embeds only its own attachments as images; every other image target renders as a link. Search excerpts are still plain text, so any Markdown in them appears as written.
- **Creating the first account requires the AWS CLI.** Right after deploying, create an account in Cognito with the AWS CLI, sign in once, then run `pnpm run seed-admin`.
- **No audit log or request rate limiting.**

## Learn More

- [AWS Blocks](https://www.npmjs.com/package/@aws-blocks/blocks) — the Infrastructure-from-Code framework this project is built on
- [Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html) — the semantic search backend
- [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol the `/mcp` endpoint speaks
- [Cloudscape Design System](https://cloudscape.design/) — the UI components

## License

[MIT License](LICENSE)

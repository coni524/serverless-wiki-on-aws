# Signing in through OneLogin

The IdP-side part of the README's SSO steps, as the actual OneLogin administration screens (verified on a real tenant, August 2026).

## Before you start

- The redirect URI: the stack output `SsoIdpRedirectUri` (before SSO is enabled, `McpSignInDomain` + `/oauth2/idpresponse`)
- Admin rights to add applications

## 1. Add the application

In the administration console: "Applications" → "Add App", search for "OpenId Connect (OIDC)", pick it, name it (e.g. `sl-wiki`), save.
On the "Configuration" tab, fill in two fields:

| Field | Value |
|---|---|
| Login Url | the wiki's origin (where the portal tile sends users) |
| Redirect URI's | `https://<pool sign-in domain>/oauth2/idpresponse` |

Assign the app to OneLogin roles to give users access.

## 2. Values to note down

On the "SSO" tab, note three values.

- **Client ID** → the entry's `clientId` in `sso.config.json`
- **Client Secret** → into Secrets Manager before the deploy
- **Issuer URL** (`https://<subdomain>.onelogin.com/oidc/2`) → the entry's `issuerUrl`

## 3. Set the Token Endpoint to POST

Still on the "SSO" tab, change "Token Endpoint" from the default `Basic` to **`POST`**.
With `Basic`, sign-in fails with "code exchange failed" (Cognito speaks only `client_secret_post`).

## 4. Put roles into the token

On the "Parameters" tab, open "Groups", set the value to "User Roles" and the output to "Semicolon Delimited input (Multi-value output)".
Also add `groups` to the scopes at deploy time (step 5) — OneLogin returns the claim only when requested.

## 5. Deploy and map roles

Continue with step 3 of the README section. The only OneLogin-specific part is the scope.
Write the entry into `sso.config.json` at the repository root and run `pnpm run deploy`.

```json
{
  "idps": [
    {
      "name": "sso",
      "label": "OneLogin",
      "issuerUrl": "https://<subdomain>.onelogin.com/oidc/2",
      "clientId": "<noted client ID>",
      "scopes": ["openid", "email", "profile", "groups"]
    }
  ]
}
```

The sign-in button's text is the entry's `label`.
To add OneLogin as a second IdP, append an entry of the same shape to the `idps` array (its name must not collide with the others).
For the second entry onwards, the secret's default name is `<stack name>-sl-wiki-sso-idp-<name>-client-secret`.

The value for a role group's "Mapping to an external IdP group" is the **role's name itself** (not a GUID like Entra's).
Non-ASCII role names go in as they are (the wiki decodes Cognito's percent-encoding).

## Operational notes

- Require MFA for federated users through OneLogin's security policies; the pool's MFA requirement applies to password accounts only
- A role change at OneLogin reaches the wiki at the user's next sign-in. Verify in a private window

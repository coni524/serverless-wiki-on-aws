# Signing in through Microsoft Entra ID

The IdP-side part of the README's SSO steps, as the actual Entra admin center screens (verified on a real tenant, August 2026).

## Before you start

- The redirect URI: the stack output `SsoIdpRedirectUri` (before SSO is enabled, `McpSignInDomain` + `/oauth2/idpresponse`)
- A role that can register applications (Application Developer or higher)

## 1. Register the application

At [entra.microsoft.com](https://entra.microsoft.com): "Identity" → "Applications" → "App registrations" → "New registration".

| Field | Value |
|---|---|
| Name | anything (e.g. `sl-wiki`) |
| Supported account types | Accounts in this organizational directory only (single tenant) |
| Redirect URI | platform "Web", value `https://<pool sign-in domain>/oauth2/idpresponse` |

## 2. Values to note down

On the "Overview" page, note two values.

- **Application (client) ID** → the entry's `clientId` in `sso.config.json`
- **Directory (tenant) ID** → build the issuer URL `https://login.microsoftonline.com/<tenant ID>/v2.0` and put it in the entry's `issuerUrl`

Scopes and the claim name work with the wiki's defaults.

## 3. Put groups into the token

Under "Token configuration" → "Add groups claim", add a groups claim to the **ID** token.
For which groups to emit, pick "Groups assigned to the application", and assign the users' groups to this app under "Enterprise applications".
On a tenant that cannot assign groups, "Security groups" works too.
The receiving attribute is capped at 2048 characters (about 50 GUIDs); a user who overflows it gets no permissions.

## 4. Create a client secret

Under "Certificates & secrets" → "New client secret", create one and copy the **Value** column.
It is shown only right after creation. Not the "Secret ID" column.

### When the create button is blocked by policy

Run these two requests in [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) to exempt just this app (you will be asked to consent to `Policy.ReadWrite.ApplicationConfiguration`).

```
POST https://graph.microsoft.com/v1.0/policies/appManagementPolicies

{ "displayName": "Allow client secret for sl-wiki",
  "isEnabled": true,
  "restrictions": { "passwordCredentials": [] } }
```

Note the `id` in the response and assign the policy to the app.
`<app object ID>` is the "Object ID" on the "Overview" page (not the client ID).

```
POST https://graph.microsoft.com/v1.0/applications/<app object ID>/appManagementPolicies/$ref

{ "@odata.id": "https://graph.microsoft.com/v1.0/policies/appManagementPolicies/<noted id>" }
```

## 5. Deploy and map groups

Continue with step 3 of the README section.
Write the entry into `sso.config.json` at the repository root and run `pnpm run deploy`.

```json
{
  "idps": [
    {
      "name": "sso",
      "label": "Entra",
      "issuerUrl": "https://login.microsoftonline.com/<tenant ID>/v2.0",
      "clientId": "<noted client ID>"
    }
  ]
}
```

The sign-in button's text is the entry's `label`.
To add Entra as a second IdP, append an entry of the same shape to the `idps` array (its name must not collide with the others).
For the second entry onwards, the secret's default name is `<stack name>-sl-wiki-sso-idp-<name>-client-secret`.

The value for a role group's "Mapping to an external IdP group" is the group's **object ID** (not its display name; visible in Entra's "Groups" list).

## Operational notes

- Require MFA for federated users through Entra's conditional access; the pool's MFA requirement applies to password accounts only
- A group change at Entra reaches the wiki a few minutes later, at the user's next sign-in. Verify in a private window

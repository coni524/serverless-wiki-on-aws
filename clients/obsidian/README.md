# Obsidian Sync Plugin

**English** | [日本語](README.ja.md)

Two-way sync between an Obsidian vault and the [serverless-wiki-on-aws](../../README.md) spaces you can read.

## Features

- Signs in to Cognito with OAuth 2.1 (authorization code flow with PKCE)
- Each selected space becomes a top-level folder in the vault: wiki folders stay folders, pages become `Title.md`
- One cycle pushes local changes — new notes and folders, edits, renames, moves — then pulls the wiki's changes
- Runs at startup, on an interval (5 minutes by default), and from the command palette ("Sync now")
- Images travel both ways: wiki attachments land in `_attachments/<page id>/`, and images you paste are uploaded to the wiki

## Prerequisites

- Obsidian 1.5.0 or later (1.11.4 or later keeps the sign-in tokens out of the vault; see [Tokens](#tokens))
- A deployed wiki, its address, and the `McpClientId` stack output
- Node.js 24 and pnpm 11 to build the plugin

## Install

The plugin is not in the community catalog yet, so build it and link it into your vault.

```bash
pnpm install                                    # at the repository root
pnpm run build                                  # in this directory
node scripts/link-vault.mjs "/path/to/vault"
```

Then, in Obsidian, turn off restricted mode under **Community plugins** and enable **sl-wiki Sync** — the plugin id still carries the project's short name.

`link-vault.mjs` symlinks `<vault>/.obsidian/plugins/slwiki-sync` to this directory, so a rebuild is picked up by "Reload app without saving". It refuses to overwrite a real directory, because that is where your settings and tokens live.

## Settings

| Setting | Value |
|---|---|
| Wiki URL | The address you open the wiki at. With CloudFront, the distribution origin; with `pnpm run sandbox`, the API Gateway URL including the `/prod` stage. |
| Client ID | The `McpClientId` stack output. |
| Spaces to sync | Press "Fetch list" and enable the spaces you want in the vault. |
| Delete on the wiki too | Per space, off by default. While it is off, a note you delete locally comes back on the next cycle. While it is on, the wiki page is deleted and the body is unrecoverable. |
| Auto-sync interval | Minutes; `0` leaves only "Sync now". |

You do not enter a sign-in address: the plugin reads `/.well-known/oauth-authorization-server` from the wiki. The client id cannot be read that way — this wiki has no dynamic client registration, and the value changes with every deployment.

"Clear the sync record" drops the id-to-file table and re-fetches every page on the next cycle. Vault files are not deleted; files that already match the wiki quietly rejoin the table.

## Conflicts

**The wiki wins, and the direction cannot be reversed in settings.**

- **Both sides edited a page** — the plugin keeps your version as `Title (conflict <date> <time>).md` in the same folder and writes the wiki's body over the original. The same applies when the two sides disagree about where a note belongs.
- **A note only one side has** — the plugin creates it on the other side.
- **A vault that already has a folder with the space's name** — if it holds anything when the space is synced for the first time (or after "Clear the sync record"), the plugin pauses that space and sends nothing. A notice says so, and the settings tab shows **Import the existing folder** under the space. Once you press it, the next cycle imports the folder: notes at the same place and name as wiki pages are matched by the rules above, and every other note and folder in it is sent to the space as a new page. An empty folder is used without asking.
- **A space renamed on the wiki** — the plugin renames the space's folder before sending anything. If a folder with the new name already exists, the space is skipped and reported until you rename that folder; the plugin never sends the notes of a folder it did not create for the space.

## What it does not sync

- Conflict copies (`(conflict ...)` files are never pushed as new pages)
- Spaces you only have `read` on — those are fetch-only
- Sibling order, because a filesystem has nowhere to put one; locally created pages land at the end on the wiki
- Attachments the body does not point at, and anything the body does not show as an image (`image/svg+xml` is refused by the wiki)

Pages deleted on the wiki are moved to the vault's `.trash`.

## Tokens

On Obsidian 1.11.4 or later, the access and refresh tokens are kept in Obsidian's secret storage, which is per vault and outside the vault folder, and `data.json` is written without them. Tokens an earlier version of the plugin left in `data.json` are moved there on the next start, and removed from `data.json` only after the copy reads back.

On an older Obsidian there is no secret storage, so the tokens stay in plain text in `<vault>/.obsidian/plugins/slwiki-sync/data.json`, and the settings tab warns about it. If your vault sits on another sync service such as iCloud, the tokens are copied there too.

The tokens are tied to the Wiki URL and client ID they were issued for, and to the sign-in endpoints the Wiki published at the time. Those endpoints must all be `https` on one origin, or the plugin refuses to sign in. If you change the Wiki URL or the client ID, the plugin treats you as signed out and sends the tokens nowhere — not to the new address, not even to revoke them. Put the old address back, or sign in again only if you trust the new address. Signing in at a new address with the same client ID first shows both addresses and asks you to confirm, because a Wiki that really moved normally gets a new client ID too.

Tokens saved by an earlier version of the plugin were stored without that record. On the first sync after updating, the plugin attaches the Wiki URL and client ID currently in the settings to them, after checking that Wiki's sign-in endpoints as above, and from then on treats them like any other sign-in. Until that succeeds they are kept but not used; signing out then tries the same check, revokes them if it passes, and removes them either way.

Signing out from the settings tab revokes the refresh token at Cognito.

## Development

```bash
pnpm run build   # type check and emit main.js
pnpm run dev     # rebuild on change
pnpm run test    # run one sync cycle against a simulated vault and wiki
```

`pnpm run test` drives the real sync engine, with `test/wiki.ts` standing in for the network and `test/vault.ts` for the disk. The cases are the ones where a mistake costs the most: folder renames from both sides, deletion with contents, and the cycle right after a migration — a cycle that can delete has to read "the user deleted this" correctly. The same file also covers what must never leave the vault: image embeds in wiki bodies, a space renamed onto an existing folder, a first sync into a non-empty folder, tokens after the Wiki URL changes, and the move of tokens into secret storage.

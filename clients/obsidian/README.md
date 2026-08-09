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

- Obsidian 1.5.0 or later
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
- **A vault that already has notes** — the first cycle applies the rules above rather than pushing everything as new pages.

## What it does not sync

- Conflict copies (`(conflict ...)` files are never pushed as new pages)
- Spaces you only have `read` on — those are fetch-only
- Sibling order, because a filesystem has nowhere to put one; locally created pages land at the end on the wiki
- Attachments the body does not point at, and anything the body does not show as an image (`image/svg+xml` is refused by the wiki)

Pages deleted on the wiki are moved to the vault's `.trash`.

## Tokens

The access and refresh tokens are stored in plain text in `<vault>/.obsidian/plugins/slwiki-sync/data.json`, which is the only place Obsidian gives a plugin. If your vault sits on another sync service such as iCloud, the tokens are copied there too. Signing out from the settings tab revokes the refresh token at Cognito.

## Development

```bash
pnpm run build   # type check and emit main.js
pnpm run dev     # rebuild on change
pnpm run test    # run one sync cycle against a simulated vault and wiki
```

`pnpm run test` drives the real sync engine, with `test/wiki.ts` standing in for the network and `test/vault.ts` for the disk. The cases are the ones where a mistake costs the most: folder renames from both sides, deletion with contents, and the cycle right after a migration — a cycle that can delete has to read "the user deleted this" correctly.

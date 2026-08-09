/**
 * Point a vault at this working copy, so Obsidian loads what is checked out.
 *
 *   node scripts/link-vault.mjs "/path/to/vault"
 *
 * A symlink from `<vault>/.obsidian/plugins/slwiki-sync` to this directory. That
 * works because Obsidian loads a plugin from a directory holding `manifest.json`
 * and `main.js`, and this directory is that directory once `pnpm run build` has
 * written `main.js` — so there is nothing to copy after an edit, only a reload.
 *
 * An existing symlink is replaced. An existing real directory is not: that is an
 * installed copy of the plugin, and deleting someone's `data.json` — their Wiki
 * URL and their tokens — is not this script's to do.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'slwiki-sync';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (vault === undefined || vault === '') {
  console.error('Pass the path to a vault: node scripts/link-vault.mjs "/path/to/vault"');
  process.exit(1);
}
if (!existsSync(join(vault, '.obsidian'))) {
  console.error(`${vault} does not look like an Obsidian vault: it has no .obsidian directory.`);
  process.exit(1);
}

const target = join(vault, '.obsidian', 'plugins', PLUGIN_ID);
mkdirSync(dirname(target), { recursive: true });

if (existsSync(target) || isSymlink(target)) {
  if (!isSymlink(target)) {
    console.error(`${target} is a real directory. Move it aside first, then run this again.`);
    process.exit(1);
  }
  if (resolve(readlinkSync(target)) === source) {
    console.log(`Already linked: ${target}`);
    process.exit(0);
  }
  rmSync(target);
}

symlinkSync(source, target, 'dir');
console.log(`Linked: ${target} -> ${source}`);
console.log('Now enable "sl-wiki Sync" under Community plugins in Obsidian.');

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

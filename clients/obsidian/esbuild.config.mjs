/**
 * Build `src/main.ts` into the single `main.js` Obsidian loads.
 *
 * Obsidian loads a plugin as one CommonJS file sitting next to `manifest.json`,
 * so the output is written to the package root rather than a `dist/` directory —
 * that way the package directory *is* the plugin directory, and a symlink from
 * the vault (`scripts/link-vault.mjs`) is all it takes to run what is checked
 * out here. `main.js` is generated and therefore git-ignored.
 *
 *   node esbuild.config.mjs              watch, with an inline source map
 *   node esbuild.config.mjs production   one build, minified, no source map
 */
import esbuild from 'esbuild';
import builtins from 'builtin-modules';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'browser',
  logLevel: 'info',
  treeShaking: true,
  sourcemap: production ? false : 'inline',
  minify: production,
  // Everything Obsidian provides at runtime. Bundling any of it would ship a
  // second copy of the editor into a plugin, and `obsidian` itself has no
  // implementation to bundle — the package is types plus a runtime shim.
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

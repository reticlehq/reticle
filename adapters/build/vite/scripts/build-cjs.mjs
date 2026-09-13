/**
 * Build the CommonJS entry, so a `vite.config.ts` in an app without `"type": "module"` can load this
 * plugin at all.
 *
 * Without that field Vite bundles the config as CJS and `require`s it, and an ESM-only plugin cannot
 * be required — so the import `reticle init` writes could not be loaded and the dev server refused to
 * start. The app served nothing until the user deleted our line, which is the worst shape a setup
 * failure can take: it looks like Reticle broke their project, because from where they are sitting it
 * did.
 *
 * A second artefact rather than a change to the first: `"type": "module"` is correct for this package
 * and for every app that has it, and the ESM build stays the one those apps load. The usual
 * dual-package hazard does not apply here — a Vite plugin runs at config time and holds no state any
 * other copy could disagree with, so loading it twice in one process is at worst wasted bytes.
 *
 * `@reticlehq/core` is BUNDLED IN because it is ESM-only, which is right for the contract at the
 * bottom of the graph and would otherwise make this build impossible. It is a workspace package we
 * publish in lockstep, so there is no version it could skew against. `@babel/core` and
 * `@reticlehq/babel-plugin` stay external: both load under CJS already, and inlining a compiler would
 * multiply this artefact for nothing.
 */
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'dist', 'index.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Matches the `engines.node` floor in package.json. Lowering it here would silently ship syntax the
  // ESM build refuses to.
  target: 'node20',
  // `vite` is a peer and optional; the other two are runtime deps that already load under CJS.
  external: ['vite', '@babel/core', '@reticlehq/babel-plugin'],
  logLevel: 'warning',
  // `import.meta.url` is one module's own location, and CJS has no `import.meta` at all — esbuild
  // substitutes an empty object and only WARNS, so the expression would evaluate to nothing and the
  // Svelte-compiler fallback that reads it would silently vanish from this build alone. `__filename`
  // is the CJS spelling of the same fact, and `createRequire` takes either a path or a file URL, so
  // both artefacts end up trying the same two origins instead of differing where nobody would look.
  define: { 'import.meta.url': '__filename' },
  // With the substitution in place there must be no `import.meta` left. Promoted to an error so that
  // dropping the define, or a new reader arriving in another file, fails the build instead of
  // quietly reading an empty object.
  logOverride: { 'empty-import-meta': 'error' },
});

if (result.warnings.length > 0) {
  for (const warning of result.warnings) console.error(warning.text);
  process.exit(1);
}

// The `require` condition needs its OWN types entry: with one top-level `types`, a CJS consumer
// resolves declarations that Node interprets as ESM, so the types only work under a dynamic import
// even though the package exports CommonJS (publint's `pkg.exports["."].types` error). The
// declarations themselves are identical, so this is a copy rather than a second `tsc` pass.
const dts = join(root, 'dist', 'index.d.ts');
copyFileSync(dts, join(root, 'dist', 'index.d.cts'));

// The zero-install reader: this package, as ONE file a browser can run with no build step.
//
// The daemon adds it to a leased page whose app never connected an SDK, so an app with no `init`
// still reaches a verdict. It is read as TEXT by the server and evaluated in the page, so the server never imports
// DOM code. Built from `dist/index.js` after tsc, which is why `build` and `prepack` both run it:
// prepack wipes `dist`, and a step that ran before it would be erased.
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
buildSync({
  entryPoints: [join(pkg, 'dist', 'index.js')],
  outfile: join(pkg, 'dist', 'reticle-inject.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'ReticleSdk',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'warning',
});

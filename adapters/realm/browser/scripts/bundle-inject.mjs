// The zero-install reader: this package, as ONE file a browser can run with no build step.
//
// The daemon adds it to a leased page whose app never connected an SDK, so an app with no `init`
// still reaches a verdict. It is read as TEXT by the server and evaluated in the page, so the server never imports
// DOM code. Built from `dist/index.js` after tsc, which is why `build` and `prepack` both run it:
// prepack wipes `dist`, and a step that ran before it would be erased.
import { buildSync } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

// The same file is also the build for bundlers that cannot read ES2020 syntax (#680). webpack 4
// (react-scripts 4) does not transpile node_modules and its parser stops at the first `?.` or `??`,
// so the app does not compile at all. It ignores `exports` and reads `module`, which points here;
// every bundler that reads `exports` keeps the modern build. Hence ES2019, and the footer: the file
// carries no `export`, so webpack 4 parses it as CommonJS and takes the SDK from `module.exports`,
// while a page evaluating it as a script has no `module` and skips the assignment. It used to be a
// second ~550KB bundle beside this one, which is what took the package past its size budget.
buildSync({
  entryPoints: [join(pkg, 'dist', 'index.js')],
  outfile: join(pkg, 'dist', 'reticle-inject.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'ReticleSdk',
  footer: { js: 'if(typeof module==="object"&&module&&module.exports)module.exports=ReticleSdk;' },
  platform: 'browser',
  target: 'es2019',
  logLevel: 'warning',
});

// The bundle is a script read as text, so it exports nothing to import. Saying so in a declaration
// file keeps type checkers, and the published-types check, from reading the subpath as untyped.
writeFileSync(
  join(pkg, 'dist', 'reticle-inject.d.ts'),
  '// A script evaluated in the page, read by the daemon as text. Nothing here is importable.\nexport {};\n',
);

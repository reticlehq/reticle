/**
 * Rewrite `@/…` out of this package's `dist` AND out of every package it references.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * `pnpm gate:install` could not start: `@reticlehq/core`'s prepack died on
 * `Cannot find package '@/vocabulary' imported from open-verification/dist/spi/realm.js`.
 *
 * Every publishable package builds with `tsc -b --force && tsc-alias`, and `tsc -b` builds the
 * PROJECT REFERENCES too — while `tsc-alias` reads one tsconfig and rewrites one `outDir`. So core's
 * prepack re-emitted open-verification's dist with the alias back in it, and nothing put it back:
 * open-verification's own prepack had already run and gone. The tarballs were fine, because each was
 * packed before the next package clobbered its dist; the working tree was not, and the first thing
 * that read a sibling's built output (core's `gen-schema.mjs`) failed.
 *
 * `prepare-dist.mjs` already refuses to pack a dist containing `@/`, and it could not see this: it
 * checks the dist being packed, and the broken one belonged to a dependency.
 *
 * The fix is to make the rewrite cover exactly what the build covered — the reference graph.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const TSC_ALIAS = join(
  dirname(require.resolve('tsc-alias/package.json')),
  'dist',
  'bin',
  'index.js',
);

/** tsconfig is JSON with comments — `tsc` allows them and this repo's configs use both kinds. */
function readTsconfig(file) {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

/** Referenced projects first, then the project itself: a dependency must not be rewritten twice. */
function graph(file, seen = new Set()) {
  const full = resolve(file);
  if (seen.has(full)) return [];
  seen.add(full);
  const config = readTsconfig(full);
  const out = [];
  for (const ref of config.references ?? []) {
    // A reference path is a directory or a tsconfig, exactly as `tsc -b` accepts it.
    const target = resolve(dirname(full), ref.path);
    out.push(...graph(target.endsWith('.json') ? target : join(target, 'tsconfig.json'), seen));
  }
  out.push(full);
  return out;
}

const entry = resolve(process.argv[2] ?? 'tsconfig.json');
for (const project of graph(entry)) {
  const run = spawnSync(process.execPath, [TSC_ALIAS, '-p', project], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

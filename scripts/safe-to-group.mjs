#!/usr/bin/env node
// Would extracting these files into a subdirectory raise the mutual-pair count?
//
// `directory-reach.test.ts` is the authority and answers only AFTER a move. That made the audit a
// sequence of move-rewrite-imports-revert cycles, and three of the first four candidate groups had
// to be reverted -- each one an expensive way to learn a fact that was sitting in the import graph
// the whole time.
//
// This answers the same question before anything moves. A group is unsafe exactly when some
// directory it reaches OUT to also reaches back IN to it: that is a mutual pair by definition, and
// it is the only way a grouping can raise the number.
//
//   node scripts/safe-to-group.mjs <dir> <name> [name...]
//
// Names are given without extension. Test files are ignored, because the guard ignores them.
// The answer is a prediction of one specific test; the test is still what decides.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';

const [, , DIR, ...NAMES] = process.argv;
if (DIR === undefined || NAMES.length === 0) {
  console.error('usage: node scripts/safe-to-group.mjs <dir> <name> [name...]');
  process.exit(2);
}

/** Every non-test source file under a root, which is the set the guard reads. */
function sources(root, out = []) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(p);
  }
  return out;
}

// The package root: walk up from the given directory to whatever holds `src`. Splitting on the
// first two segments worked while every package was one level down and stopped the day one was
// not, which is the same assumption that broke fifty path literals elsewhere in this repo.
const ROOT = DIR.slice(0, DIR.indexOf('/src/') + 4);
const files = new Set(sources(ROOT).map((p) => resolve(p)));
const imports = new Map();
for (const p of files) {
  const found = new Set();
  for (const m of readFileSync(p, 'utf8').matchAll(/from '([./][^']*)\.js'/g)) {
    const target = resolve(dirname(p), `${m[1]}.ts`);
    if (files.has(target)) found.add(target);
  }
  imports.set(p, found);
}

const group = new Set(NAMES.map((n) => resolve(join(DIR, `${n}.ts`))).filter((p) => files.has(p)));
const dirOf = (p) => basename(dirname(p));
const label = (p) => (dirname(p) === resolve(DIR) ? 'PARENT' : dirOf(p));

const out = new Set();
for (const p of group) for (const t of imports.get(p) ?? []) if (!group.has(t)) out.add(label(t));

const inbound = new Set();
for (const p of files) {
  if (group.has(p)) continue;
  for (const t of imports.get(p) ?? []) if (group.has(t)) inbound.add(label(p));
}

const mutual = [...out].filter((d) => inbound.has(d)).sort();
console.log(`group of ${String(group.size)} in ${DIR}`);
console.log(`  reaches out to : ${[...out].sort().join(', ') || '(nothing)'}`);
console.log(`  reached in from: ${[...inbound].sort().join(', ') || '(nobody)'}`);
console.log(mutual.length > 0 ? `  UNSAFE — mutual with: ${mutual.join(', ')}` : '  SAFE');
process.exit(mutual.length > 0 ? 1 : 0);

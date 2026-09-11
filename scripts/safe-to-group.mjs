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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
//
// `/src/` with BOTH slashes only matches a directory INSIDE src. Asked about `core/src` itself
// -- a package root, which is a normal thing to ask about and where four of this repo's biggest
// flat directories live -- `indexOf` returned -1, the slice produced `cor`, and the tool died
// on `scandir 'cor'`. It had been answering nothing for every package root all along, and a
// sweep over them read as "no groups here" rather than as a crash.
const INSIDE = DIR.indexOf('/src/');
const ROOT = -1 !== INSIDE ? DIR.slice(0, INSIDE + 4) : DIR.replace(/\/src\/?$/, '/src');
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

const asked = NAMES.map((n) => resolve(join(DIR, `${n}.ts`)));
const group = new Set(asked.filter((p) => files.has(p)));

/**
 * Named, present on disk, and invisible to this tool -- which is not the same as safe.
 *
 * `sources()` drops test files because the guard drops them, so a group of tests produces an
 * empty group and prints "(nothing)" on every line. That reads as a clean bill of health when
 * it means "I cannot see these files". It is the more dangerous half of the two, because the
 * guard cannot see them either: MUTUAL_PAIRS_TODAY is computed over non-test sources ONLY, so
 * moving tests around can never raise it, and "the count did not move" is then a fact about
 * the guard rather than about the move.
 *
 * Two extractions on this branch -- 27 repo-wide guards, then 3 daemon tests -- were signed off
 * with "MUTUAL_PAIRS_TODAY unchanged". True, and guaranteed before either file moved. The
 * moves were still worth making, because 160 flat files in one directory is a real problem and
 * 133 is less of one; only the verification was weaker than it was reported to be.
 */
const invisible = asked.filter((p) => !files.has(p) && existsSync(p));

/**
 * Nothing resolved, which is not the same as nothing being wrong.
 *
 * An empty group reaches nothing, is reached by nothing, frees nothing and prints SAFE -- a
 * clean bill of health for a question nobody asked. That is how this tool told me three
 * groupings were safe when my shell had passed all the names as ONE argument: zsh does not
 * word-split an unquoted parameter, so `$g` arrived as a single unresolvable name.
 *
 * The same shape as an orphan scan over zero files, and the same fix: refuse, rather than
 * answer about nothing. Named files that exist but are TESTS are reported separately above;
 * this is for names that resolve to nothing at all.
 */
const unresolved = asked.filter((p) => !files.has(p) && !existsSync(p));
// Only when nothing resolved AND nothing was a test. Naming only test files is a real question
// with a real answer -- the NOTE below says the guard cannot see them, which is the useful
// reply. Naming something that does not exist is not a question at all.
if (0 === group.size && 0 === invisible.length) {
  console.error(
    `no source file in ${DIR} matched: ${unresolved.map((p) => basename(p, '.ts')).join(', ')}\n` +
      'An empty group would print SAFE while answering nothing. Pass each name as its own\n' +
      'argument -- in zsh an unquoted "a b c" is ONE word, not three.',
  );
  process.exit(2);
}
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

/**
 * Reaches on the PARENT that this extraction would delete.
 *
 * The property that separates a grouping worth making from one that merely moves a file. A
 * directory stops reaching for the parent only if the extracted files were the ONLY reason it
 * reached at all -- and that is the difference between `fs-port`, whose extraction deleted
 * `cloud -> project` and `command -> project`, and `numeric-bounds`, whose extraction deleted
 * nothing and added nine reaches for one file.
 *
 * High fan-in suggests a candidate. This decides whether it is a good one.
 */
const parent = resolve(DIR);
const freed = [];
for (const d of inbound) {
  if (d === 'PARENT') continue;
  const others = [...files].some(
    (p) =>
      label(p) === d &&
      [...(imports.get(p) ?? [])].some((t) => dirname(t) === parent && !group.has(t)),
  );
  if (!others) freed.push(d);
}

/**
 * Filenames this package has already promised to somebody else.
 *
 * A wildcard export -- `"./evidence/*.js"` -- makes every file under that directory a public
 * entry point. A pattern substitutes across slashes, so moving one into a subdirectory keeps
 * resolving for US: the type checker is happy, the build is happy, every test is happy, and the
 * verdict above stays SAFE, because nothing about the coupling changed. The path a user was
 * given is simply gone, and the breakage is entirely on the other side of the package boundary
 * where nothing in this repository can see it.
 *
 * This tool sent me at exactly that move. Four files in `engine/src/evidence` predicted SAFE,
 * moved, and reverted only because `public-subpaths-are-pinned.test.ts` happened to name
 * `evidence/gaps/` in a comment as the worked example. A reader who had not opened that file
 * would have committed it. The guard is still the authority -- it pins the filenames and fails
 * a commit that changes them -- but advice given before the move should not be silent about the
 * one consequence the mutual-pair count cannot express.
 *
 * Packages that export only `"."` are deliberately quiet here. Every file under their `src/` is
 * private and may be rearranged freely, and that is most of this repository; a tool that warned
 * on every move would teach people to read past the warning.
 */
function publicSpecifiers() {
  const manifest = join(dirname(ROOT), 'package.json');
  if (!existsSync(manifest)) return [];
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const exports = pkg.exports;
  if (typeof exports !== 'object' || null === exports) return [];
  const found = [];
  for (const key of Object.keys(exports)) {
    if (!key.includes('*')) continue;
    const [prefix, suffix] = key.replace(/^\.\//, '').split('*');
    for (const p of group) {
      const spec = relative(ROOT, p).replace(/\.ts$/, '.js');
      if (spec.startsWith(prefix) && spec.endsWith(suffix)) {
        found.push(`${pkg.name}/${spec}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

const promised = publicSpecifiers();
if (promised.length > 0) {
  console.log(
    `PUBLIC: ${String(promised.length)} of these file(s) are published entry points. Moving one\n` +
      '        is a BREAKING CHANGE for anybody who imported it, and nothing in this repository\n' +
      '        goes red -- a wildcard subpath substitutes across slashes, so the move keeps\n' +
      '        resolving here and stops resolving for them. These specifiers would die:\n' +
      promised.map((s) => `          ${s}`).join('\n') +
      '\n        Doing it anyway is fine when it is deliberate: update the pinned list in\n' +
      '        public-subpaths-are-pinned.test.ts in the same commit, and name the old path and\n' +
      '        the new one in the changelog.',
  );
}

if (invisible.length > 0) {
  console.log(
    `NOTE: ${String(invisible.length)} of ${String(asked.length)} named file(s) are TESTS.\n` +
      '      directory-reach reads non-test sources only, so it cannot see them and cannot\n' +
      '      count them. Moving them will not raise MUTUAL_PAIRS_TODAY whatever they import,\n' +
      '      and a green run afterwards says nothing about coupling. Judge the move on whether\n' +
      '      the directory reads better, which is a real reason, and do not call it verified.',
  );
}
console.log(`group of ${String(group.size)} in ${DIR}`);
console.log(`  reaches out to : ${[...out].sort().join(', ') || '(nothing)'}`);
console.log(`  reached in from: ${[...inbound].sort().join(', ') || '(nobody)'}`);
console.log(
  `  would FREE     : ${freed.sort().join(', ') || '(nothing — this only moves a file)'}`,
);
console.log(mutual.length > 0 ? `  UNSAFE — mutual with: ${mutual.join(', ')}` : '  SAFE');
process.exit(mutual.length > 0 ? 1 : 0);

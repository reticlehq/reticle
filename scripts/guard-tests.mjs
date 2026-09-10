/**
 * Which of a package's tests read the REST OF THE REPO, and therefore cannot be cached like the rest.
 *
 * `@reticlehq/server#test:unit` declared seventeen `$TURBO_ROOT$` input globs — `docs/**`, `apps/**`,
 * `bench/**`, `.github/**`, `README.md` and more. That breadth is not a mistake: two dozen tests in
 * that package really do scan those trees, and `guards-are-cache-invalidated.test.ts` exists because
 * omitting them once made the suite replay a pass recorded against files it had never opened.
 *
 * The cost was that ANY change anywhere in this repo — a typo in a doc, a line in a workflow —
 * invalidated the whole task. Measured: 679 test files, 6,772 tests, 144 seconds, re-run in full to
 * find out whether 23 of those files still agreed with a document. The repo-scanning half is 23
 * files, 192 tests, 2 seconds.
 *
 * So the two halves are two turbo tasks now, and this is the thing that tells them apart. It is a
 * function rather than a list or a filename convention on purpose:
 *
 *   - A LIST would be correct on the day it was written and silently short afterwards, which is the
 *     exact failure `guards-are-cache-invalidated.test.ts` was written to stop.
 *   - A CONVENTION (`*.guard.test.ts`) puts the classification in a name somebody has to remember to
 *     use. A new cross-package guard would land in the narrow task, replay a stale green, and look
 *     identical to working — again the same failure, one rename later.
 *
 * Detected instead, from the only thing a test MUST do before it can read outside its own package:
 * construct a path that leaves it. Every test file under `packages/<pkg>/src` is at most one
 * directory deep, so three consecutive `..` segments — or a `../../..` written as one literal, or a
 * `process.cwd(), '..'` step into a sibling — is always outside the package and nothing that stays
 * inside can spell it.
 *
 * That is a deliberately COARSER rule than matching the reads themselves. Matching reads was tried
 * first and it under-detected: it found `join(REPO, 'docs')` and missed `join(REPO, root)`,
 * `join(REPO_ROOT, 'docs', 'cli', 'doctor.mdx')` and `cwd: REPO` — nineteen real repo-scanning
 * tests, every one of which would then have landed in the narrow task and replayed a stale green,
 * which is precisely the defect this split must not introduce. Over-detection costs two seconds in
 * the cheap task. Under-detection is a false green in the gate. They are not comparable, so the rule
 * errs one way on purpose.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Spelling a path that leaves the package. Any one of these is enough.
 *
 *   join(HERE, '..', '..', '..', '..')  — the walk to the repo root, at any of its depths.
 *   new URL('.', import.meta.url) + '../../..'  — the same walk as one literal.
 *   join(process.cwd(), '..', 'tauri')  — a sideways step into a sibling package.
 */
const ESCAPES = [
  /'\.\.'\s*,\s*'\.\.'\s*,\s*'\.\.'/,
  /["'`]\.\.\/\.\.\/\.\./,
  /process\.cwd\(\)\s*,\s*'\.\.'/,
];

function testFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || 'dist' === entry) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Does this file build a path out of its own package? */
export function escapesPackage(file) {
  const text = readFileSync(file, 'utf8');
  return ESCAPES.some((pattern) => pattern.test(text));
}

/**
 * The guard half of a package's suite: every test file that reads outside the package, as a path
 * relative to the package root and always with forward slashes, because these become vitest
 * arguments and a backslash there is a glob escape.
 */
export function guardTests(packageDir) {
  const src = join(packageDir, 'src');
  return testFiles(src)
    .filter((file) => escapesPackage(file))
    .map((file) => relative(packageDir, file).split(sep).join('/'))
    .sort();
}

/** Vitest's own entry, run through `node` so this works where `.cmd` shims do not resolve. */
function vitestCli(packageDir) {
  const require = createRequire(join(packageDir, 'package.json'));
  const manifest = require.resolve('vitest/package.json');
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  return join(manifest, '..', parsed.bin.vitest);
}

function run(packageDir, mode) {
  const guards = guardTests(packageDir);
  // A package with no repo-scanning tests has nothing to run in this half, and saying so is the
  // whole answer. Handing vitest an empty list of files does NOT mean "no files" -- it means "no
  // filter", so it would run the entire suite a second time. That is invisible from the outside:
  // the task passes, it just costs another full run of everything for nothing. Found when the rules
  // became their own package and became the first package here with no repo-scanning test at all.
  if ('guards' === mode && 0 === guards.length) {
    console.log('no tests here read outside this package, so there is nothing in the guard half');
    process.exit(0);
  }
  const args =
    'guards' === mode
      ? ['run', '--passWithNoTests', ...guards]
      : ['run', '--passWithNoTests', 'src', ...guards.flatMap((g) => ['--exclude', g])];
  const result = spawnSync(process.execPath, [vitestCli(packageDir), ...args], {
    cwd: packageDir,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const [mode] = process.argv.slice(2);
if ('list' === mode) console.log(guardTests(process.cwd()).join('\n'));
else if ('guards' === mode || 'unit' === mode) run(process.cwd(), mode);
else if (mode !== undefined) {
  console.error(`usage: guard-tests.mjs list|guards|unit   (run from the package root)`);
  process.exit(2);
}

#!/usr/bin/env node
/**
 * Rebase a pull request written against the old `packages/*` layout onto the current tree.
 *
 * The v3 restructure moved every package directory and deleted `packages/`, which put 40 of 55 open
 * pull requests into conflict against a path that no longer exists (#979). It also re-homed most
 * files inside those packages, so a package-root prefix is the wrong destination for 1192 of the
 * 1699 files git itself recorded as renames (#1033). Recovery is still a table lookup: the table is
 * git's rename map (`v3-package-renames.tsv`, from `git diff -M` between v2.14.0 and this tree),
 * not the twelve package roots. Rewrite the paths in each commit's patch headers, replay onto
 * `main`, force-push the contributor's branch.
 *
 * It rewrites PATCH HEADERS ONLY — never a `+`/`-` content line. A relative import or a workspace
 * path inside a file is a source change that belongs to whoever reviews the PR; rewriting it here
 * would silently edit a contributor's code under their name.
 *
 * Dry run by default. `--apply` force-pushes, and is the only destructive mode.
 *
 * Incident: the v3 restructure (5d475e05) stranded 40 open PRs the day it shipped; none had been
 * rebased four days later, and the contributors had no way to know why their branch went red.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where each package directory went. The last resort, used only when the rename map has never seen
 * that directory: a file added in a folder the restructure did not move any file out of. A directory
 * the map HAS seen, and split across more than one destination, is left untouched. Guessing
 * `server/src/events/lineage.ts` for a file that git put in `engine/` is the miss #1033 measured.
 */
const MOVED = {
  'packages/core/': 'core/',
  'packages/server/': 'server/',
  'packages/init/': 'init/',
  'packages/test/': 'spec-runner/',
  'packages/browser/': 'adapters/realm/browser/',
  'packages/electron/': 'adapters/realm/electron/',
  'packages/tauri/': 'adapters/realm/tauri/',
  'packages/react/': 'adapters/framework/react/',
  'packages/vite-plugin/': 'adapters/build/vite/',
  'packages/babel-plugin/': 'adapters/build/babel-plugin/',
  'packages/next/': 'adapters/build/next/',
  'packages/eslint-plugin/': 'adapters/lint/eslint/',
};

/**
 * The patch lines that carry a path. Anything else is content and is left exactly as the author
 * wrote it — the distinction is the whole safety property of this script.
 */
const PATH_LINE =
  /^(diff --git |--- |\+\+\+ |rename from |rename to |copy from |copy to |Binary files )/;

const RENAME_MAP = join(dirname(fileURLToPath(import.meta.url)), 'v3-package-renames.tsv');

/**
 * Exact old-to-new paths, plus the directories that moved as a unit.
 *
 * A directory is unambiguous when every renamed file under it kept the same relative suffix, so a
 * file the pull request added beside them follows the same move. A directory whose children left
 * for different places (`packages/server/src/events/` went to three directories under `engine/`)
 * is ambiguous: a new file there is reported as a real conflict instead of written to a path that
 * does not exist.
 */
function loadRenameIndex(text) {
  const exact = new Map();
  for (const line of text.split('\n')) {
    if (0 === line.length) continue;
    const tab = line.indexOf('\t');
    if (0 > tab) continue;
    exact.set(line.slice(0, tab), line.slice(tab + 1));
  }
  const byDir = new Map();
  for (const [oldPath, newPath] of exact) {
    const parts = oldPath.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      const bucket = byDir.get(dir) ?? [];
      bucket.push([oldPath.slice(dir.length), newPath]);
      byDir.set(dir, bucket);
    }
  }
  const unambiguous = new Map();
  const ambiguous = new Set();
  for (const [dir, files] of byDir) {
    let newDir = null;
    let ok = true;
    for (const [rest, newPath] of files) {
      if (!newPath.endsWith(rest)) {
        ok = false;
        break;
      }
      const candidate = newPath.slice(0, newPath.length - rest.length);
      if (null === newDir) newDir = candidate;
      else if (newDir !== candidate) {
        ok = false;
        break;
      }
    }
    if (ok && null !== newDir && newDir !== dir) unambiguous.set(dir, newDir);
    else if (!ok) ambiguous.add(dir);
  }
  return { exact, unambiguous, ambiguous };
}

const renameIndex = loadRenameIndex(readFileSync(RENAME_MAP, 'utf8'));

/**
 * The path this old `packages/` path has on the current tree, or null when the directory was split
 * and this particular file was not in the rename map.
 */
function resolveMovedPath(oldPath, index = renameIndex) {
  if (!oldPath.startsWith('packages/')) return oldPath;
  const exact = index.exact.get(oldPath);
  if (undefined !== exact) return exact;
  const parts = oldPath.split('/');
  for (let i = parts.length - 1; 1 <= i; i -= 1) {
    const dir = `${parts.slice(0, i).join('/')}/`;
    const moved = index.unambiguous.get(dir);
    if (undefined !== moved) return moved + oldPath.slice(dir.length);
    if (index.ambiguous.has(dir)) return null;
  }
  for (const [from, to] of Object.entries(MOVED)) {
    if (oldPath.startsWith(from)) return to + oldPath.slice(from.length);
  }
  return null;
}

function rewriteOnePath(path, index) {
  if (!path.startsWith('packages/')) return path;
  return resolveMovedPath(path, index) ?? path;
}

/** Rewrite `a/` and `b/` paths in one header. Content lines never reach here. */
function rewritePrefixedPaths(line, index) {
  let out = '';
  let cursor = 0;
  while (cursor < line.length) {
    const aAt = line.indexOf('a/', cursor);
    const bAt = line.indexOf('b/', cursor);
    let at = -1;
    if (0 <= aAt && (0 > bAt || aAt <= bAt)) at = aAt;
    else if (0 <= bAt) at = bAt;
    if (0 > at) {
      out += line.slice(cursor);
      break;
    }
    const atBoundary = 0 === at || ' ' === line[at - 1];
    if (!atBoundary) {
      out += line.slice(cursor, at + 2);
      cursor = at + 2;
      continue;
    }
    const start = at + 2;
    let end = start;
    while (end < line.length && ' ' !== line[end] && '\t' !== line[end]) end += 1;
    out += line.slice(cursor, start) + rewriteOnePath(line.slice(start, end), index);
    cursor = end;
  }
  return out;
}

function remapLine(line, index) {
  if (!PATH_LINE.test(line)) return line;
  if (
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('copy from ') ||
    line.startsWith('copy to ')
  ) {
    const second = line.indexOf(' ', line.indexOf(' ') + 1);
    return line.slice(0, second + 1) + rewriteOnePath(line.slice(second + 1), index);
  }
  return rewritePrefixedPaths(line, index);
}

const git = (args, opts = {}) =>
  // `?? ''`: a command whose stdout is not piped returns null, and `.trim()` on that used to throw
  // from inside the `am --abort` recovery path, replacing every real conflict message with a
  // TypeError. An error handler that cannot report is worse than no error handler.
  (
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ??
    ''
  ).trim();

/** Best-effort cleanup: a failure here must never replace the failure we are reporting. */
const gitQuietly = (args, opts = {}) => {
  try {
    execFileSync('git', args, { stdio: 'ignore', ...opts });
  } catch {
    /* the caller is already on an error path */
  }
};

/** Rewrite every moved path in one patch file's headers. Returns how many lines changed. */
function remapPatch(file, index = renameIndex) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    const next = remapLine(line, index);
    if (next !== line) changed += 1;
    return next;
  });
  if (changed > 0) writeFileSync(file, out.join('\n'));
  return changed;
}

function failSelfTest(why) {
  process.stderr.write(`remap self-test failed: ${why}\n`);
  process.exit(1);
}

/**
 * Proves the two failures #1033 measured: a renamed file follows git, and a patch body is not a
 * header. Run before any `gh` call so the check does not need a network or a pull request.
 */
function selfTest() {
  const lineage = resolveMovedPath('packages/server/src/events/lineage.ts');
  if ('engine/src/question/lineage.ts' !== lineage) {
    failSelfTest(`lineage resolved to ${String(lineage)}`);
  }
  const lineageTest = resolveMovedPath('packages/server/src/events/lineage.test.ts');
  if ('engine/src/question/lineage.test.ts' !== lineageTest) {
    failSelfTest(`lineage test resolved to ${String(lineageTest)}`);
  }
  const tool = resolveMovedPath('packages/server/src/tools/lineage-tools.ts');
  if ('server/src/surface/tools/lineage-tools.ts' !== tool) {
    failSelfTest(`lineage tool resolved to ${String(tool)}`);
  }
  const addedBeside = resolveMovedPath('packages/server/src/telemetry/not-a-real-file.ts');
  if ('server/src/telemetry/not-a-real-file.ts' !== addedBeside) {
    failSelfTest(`telemetry neighbour resolved to ${String(addedBeside)}`);
  }
  if (null !== resolveMovedPath('packages/server/src/events/not-a-real-file.ts')) {
    failSelfTest('a new file in a split directory was guessed');
  }
  const patch = join(mkdtempSync(join(tmpdir(), 'remap-self-')), '0001.patch');
  writeFileSync(
    patch,
    [
      'diff --git a/packages/server/src/events/lineage.ts b/packages/server/src/events/lineage.ts',
      '--- a/packages/server/src/events/lineage.ts',
      '+++ b/packages/server/src/events/lineage.ts',
      '@@ -1 +1 @@',
      '-old',
      "+import 'packages/server/src/events/lineage.ts'",
      '',
    ].join('\n'),
  );
  if (3 !== remapPatch(patch))
    failSelfTest('expected the three headers to change and the body to stay');
  const rewritten = readFileSync(patch, 'utf8');
  if (!rewritten.includes('a/engine/src/question/lineage.ts')) {
    failSelfTest('diff header was not rewritten to the git destination');
  }
  if (!rewritten.includes("import 'packages/server/src/events/lineage.ts'")) {
    failSelfTest('a content line was rewritten');
  }
  process.stdout.write('remap self-test passed\n');
}

function rescue(pr, { apply, worktree }) {
  const head = JSON.parse(
    execFileSync(
      'gh',
      ['pr', 'view', String(pr), '--json', 'headRefName,headRepositoryOwner,maintainerCanModify'],
      { encoding: 'utf8' },
    ),
  );
  const { headRefName: ref, maintainerCanModify: mayPush } = head;
  const owner = head.headRepositoryOwner.login;
  const remote = `https://github.com/${owner}/reticle.git`;

  git(['fetch', '--quiet', remote, `${ref}:refs/remap/${pr}`], { cwd: worktree });
  const base = git(['merge-base', 'origin/main', `refs/remap/${pr}`], { cwd: worktree });

  const patches = mkdtempSync(join(tmpdir(), `remap-${pr}-`));
  git(['format-patch', '--quiet', '-o', patches, `${base}..refs/remap/${pr}`], { cwd: worktree });
  const files = readdirSync(patches)
    .sort()
    .map((f) => join(patches, f));
  if (0 === files.length) return { pr, status: 'nothing-to-replay' };

  let remapped = 0;
  for (const f of files) remapped += remapPatch(f);

  git(['checkout', '--quiet', '-B', `remap/${pr}`, 'origin/main'], { cwd: worktree });
  try {
    git(['am', '--3way', '--quiet', ...files], { cwd: worktree });
  } catch (err) {
    // A conflict here is a REAL conflict with work landed since, not the rename. Those need a human.
    gitQuietly(['am', '--abort'], { cwd: worktree });
    return {
      pr,
      owner,
      ref,
      status: 'needs-human',
      commits: files.length,
      remapped,
      detail: String(err.stderr ?? err.message).slice(0, 200),
    };
  }

  if (!apply) return { pr, owner, ref, status: 'clean', commits: files.length, remapped };
  if (!mayPush)
    return { pr, owner, ref, status: 'no-push-permission', commits: files.length, remapped };
  git(['push', '--force-with-lease', remote, `remap/${pr}:${ref}`], { cwd: worktree });
  return { pr, owner, ref, status: 'pushed', commits: files.length, remapped };
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
  process.exit(0);
}
const apply = args.includes('--apply');
const prs = args.filter((a) => /^\d+$/.test(a)).map(Number);
if (0 === prs.length) {
  process.stderr.write('usage: node scripts/remap-stranded-prs.mjs [--apply] <pr> [pr...]\n');
  process.exit(1);
}

const worktree = mkdtempSync(join(tmpdir(), 'remap-wt-'));
git(['worktree', 'add', '--quiet', '--detach', worktree, 'origin/main']);
const results = [];
try {
  for (const pr of prs) {
    try {
      results.push(rescue(pr, { apply, worktree }));
    } catch (err) {
      results.push({
        pr,
        status: 'error',
        detail: String(err.stderr ?? err.message).slice(0, 200),
      });
    }
  }
} finally {
  // Leave the repository as it was found. The first version did not: a dry run over the whole
  // stranded list left forty `remap/<pr>` branches and forty `refs/remap/<pr>` behind in the caller's
  // .git, which is forty-one pieces of clutter from a command whose whole promise is that it changes
  // nothing. A rerun rebuilds any of it in seconds, so keeping it buys nothing and costs the next
  // person a `git branch` they have to reason about.
  git(['worktree', 'remove', '--force', worktree]);
  for (const pr of prs) {
    gitQuietly(['branch', '-D', `remap/${pr}`]);
    gitQuietly(['update-ref', '-d', `refs/remap/${pr}`]);
  }
}

for (const r of results) {
  process.stdout.write(
    `#${r.pr}\t${r.status}\tcommits=${r.commits ?? 0}\tpaths=${r.remapped ?? 0}\t${r.detail ?? ''}\n`,
  );
}
const bad = results.filter((r) => 'clean' !== r.status && 'pushed' !== r.status).length;
process.stdout.write(
  `\n${results.length - bad}/${results.length} recoverable${apply ? ' (pushed)' : ' (dry run)'}\n`,
);
process.exitCode = 0;

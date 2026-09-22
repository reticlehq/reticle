#!/usr/bin/env node
/**
 * Rebase a pull request written against the old `packages/*` layout onto the current tree.
 *
 * The v3 restructure moved every package directory and deleted `packages/`, which put 40 of 55 open
 * pull requests into conflict against a path that no longer exists (#979). The move was a clean rename,
 * so recovering those branches is a table lookup rather than a merge: rewrite the paths in each
 * commit's patch headers, replay onto `main`, force-push the contributor's branch.
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
import { join } from 'node:path';

/** Where each package directory went in the v3 restructure. Verified against `git ls-tree main`. */
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
function remapPatch(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    if (!PATH_LINE.test(line)) return line;
    let next = line;
    for (const [from, to] of Object.entries(MOVED)) {
      // Paths appear as `a/packages/x/…`, `b/packages/x/…` or bare in rename/copy lines.
      next = next.split(`a/${from}`).join(`a/${to}`).split(`b/${from}`).join(`b/${to}`);
      if (next.startsWith('rename ') || next.startsWith('copy ')) next = next.split(from).join(to);
    }
    if (next !== line) changed += 1;
    return next;
  });
  if (changed > 0) writeFileSync(file, out.join('\n'));
  return changed;
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

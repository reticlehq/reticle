#!/usr/bin/env node
/**
 * Stop the open PR list from lying, in the two directions it does.
 *
 * `check-stale-issues.mjs` guards the issue list against a fix that landed. This is its mirror
 * image, and the failures it catches were both measured on 2026-09-08:
 *
 * - **Ten open PRs whose work was already on `main`**, some open for over two weeks. #645's own
 *   merge commit says "Merge PR #645" and GitHub never closed it. Each author was left believing
 *   their work was still pending, and every reviewer who opened one spent the time twice.
 * - **19 of 53 open issues had an open PR nobody could see.** GitHub surfaces that nowhere a reader
 *   notices, and contributors' titles rarely carry the issue number, so grepping the PR list for
 *   `#NNN` finds nothing. Four duplications in one day, two of them by the maintainer.
 *
 * REPORTS, never fails. Both answers are hints — a title match is evidence that something with that
 * subject landed, not proof this PR did — and a check that closes a contributor's work on a
 * substring would be worse than the problem. Exit code is always 0; the reader decides.
 *
 * SKIPS RATHER THAN FAILS when it cannot see, for the same reason its sibling does: no `gh`, no
 * network, no auth. It says so rather than passing silently.
 *
 * Usage: node scripts/check-open-prs.mjs [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  landedPullRequests,
  landedPullRequestReport,
  issuesWithOpenPr,
  unannouncedClaimReport,
} = require('../packages/server/dist/dev/open-pr-guard.js');

/** How far back on `main` to look for a subject match. A PR older than this is a different problem. */
const MAIN_SUBJECT_DEPTH = 400;

const limitFlag = process.argv.indexOf('--limit');
const LIMIT = limitFlag === -1 ? '100' : (process.argv[limitFlag + 1] ?? '100');

/**
 * The negative control, for the reason its sibling has one: a guard nobody has watched go red proves
 * nothing when it is green. Feeds each check the shape it exists to catch and fails loudly if it
 * comes back clean.
 */
if (process.argv.includes('--self-test')) {
  const landed = landedPullRequests(
    [{ number: 1, title: 'fix(server): a subject long enough to match', body: '' }],
    ['fix(server): a subject long enough to match (#1)'],
  );
  const claims = issuesWithOpenPr([{ number: 2, title: 't', body: 'Closes #7' }], [7]);
  const quiet = landedPullRequests(
    [{ number: 3, title: 'feat: something never merged anywhere', body: '' }],
    ['chore: unrelated'],
  );
  if (1 !== landed.length || 1 !== claims.length || 0 !== quiet.length) {
    console.error(
      'open-pr guard self-test FAILED: the checks no longer catch what they exist for.',
    );
    process.exit(1);
  }
  console.log(
    'open-pr guard self-test: catches a landed PR and an unannounced claim, quiet on neither.',
  );
  process.exit(0);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function skip(why) {
  // Exit 0 deliberately. See the header: an unavailable check must not become a red build.
  console.log(`open-pr guard SKIPPED — ${why}`);
  process.exit(0);
}

let prs;
try {
  prs = JSON.parse(
    run('gh', ['pr', 'list', '--state', 'open', '--limit', LIMIT, '--json', 'number,title,body']),
  );
} catch {
  skip('could not list open pull requests (no gh, no auth, or no network)');
}

let openIssues = [];
try {
  openIssues = JSON.parse(
    run('gh', ['issue', 'list', '--state', 'open', '--limit', LIMIT, '--json', 'number']),
  ).map((issue) => issue.number);
} catch {
  // Non-fatal: the landed-PR half below does not need the issue list, so report what we can.
  console.log('open-pr guard: could not list open issues — the claim half is skipped.');
}

let subjects = [];
try {
  subjects = run('git', ['log', 'origin/main', `-${String(MAIN_SUBJECT_DEPTH)}`, '--format=%s'])
    .split('\n')
    .filter((line) => line.length > 0);
} catch {
  console.log('open-pr guard: could not read origin/main — the landed half is skipped.');
}

const landed = landedPullRequests(prs, subjects);
const claims = issuesWithOpenPr(prs, openIssues);

const landedText = landedPullRequestReport(landed);
const claimsText = unannouncedClaimReport(claims);

if ('' === landedText && '' === claimsText) {
  console.log(`open-pr guard: ${String(prs.length)} open PRs, nothing to flag.`);
  process.exit(0);
}
if ('' !== landedText) console.log(`\n${landedText}\n`);
if ('' !== claimsText) console.log(`\n${claimsText}\n`);
// Always 0: this reports, it does not gate. See the header.
process.exit(0);

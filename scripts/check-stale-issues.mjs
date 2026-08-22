#!/usr/bin/env node
/**
 * Refuse to let an issue we have already fixed keep reading as available work.
 *
 * Three contributor PRs died on arrival in one week because of this. #373 was filed at 09:52 and
 * fixed by us at 12:33 the same day, then left open for three more days — somebody started on it on
 * day two. #398 shipped and stayed open; a second contributor rebuilt it from scratch. `GITHUB.md`
 * already records the same failure costing three contributors before either, which makes this the
 * third recurrence of something we wrote down and asked ourselves to remember.
 *
 * Remembering is not a mechanism. A commit that says `Closes #N` is a claim the work is done; if #N
 * is still open and unlabelled, the tracker is lying to the next person who reads it, and that
 * person is by definition looking for something to start.
 *
 * The decision logic lives in `packages/server/src/dev/stale-issue-guard.ts` and is unit-tested.
 * This file is the IO around it: what the commits say, and what GitHub says back.
 *
 * SKIPS RATHER THAN FAILS when it cannot see: no `gh`, no network, no auth, a fork PR without a
 * token. A guard that goes red for reasons unrelated to what it guards is one people disable, which
 * would cost more than the defect. It reports what it could not check, so a skip is never silent.
 *
 * Usage: node scripts/check-stale-issues.mjs [baseRef]   (default origin/main)
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  closedRefsIn,
  staleIssues,
  staleIssueReport,
} = require('../packages/server/dist/dev/stale-issue-guard.js');

const BASE = process.argv[2] ?? 'origin/main';

/**
 * The negative control, run FIRST in CI for the same reason `gate:install:self-test` is: a guard
 * nobody has watched go red proves nothing when it is green. This feeds the decision logic the
 * shape it exists to catch and fails loudly if it comes back clean.
 */
if (process.argv.includes('--self-test')) {
  const wouldCatch = staleIssues([1], [{ number: 1, state: 'open', labels: ['bug'] }]);
  const wouldAllow = staleIssues(
    [2],
    [{ number: 2, state: 'open', labels: ['fixed-pending-release'] }],
  );
  if (1 !== wouldCatch.length || 0 !== wouldAllow.length) {
    console.error(
      '✗ stale-issue guard SELF-TEST FAILED — the guard cannot catch what it exists for.',
    );
    process.exit(1);
  }
  console.log(
    'stale-issue guard self-test: catches an unlabelled open issue, allows a labelled one.',
  );
  process.exit(0);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function skip(why) {
  // Exit 0 deliberately. See the header: an unavailable check must not become a red build.
  console.log(`stale-issue guard SKIPPED — ${why}`);
  process.exit(0);
}

let commits;
try {
  commits = run('git', ['log', `${BASE}..HEAD`, '--format=%B%x00']);
} catch {
  skip(`could not read git log against ${BASE}`);
}

const claimed = [...new Set(commits.split('\0').flatMap((message) => closedRefsIn(message)))];
if (0 === claimed.length) {
  console.log('stale-issue guard: no commit on this branch claims to close an issue.');
  process.exit(0);
}

const issues = [];
const unresolved = [];
for (const number of claimed) {
  try {
    const raw = run('gh', ['issue', 'view', String(number), '--json', 'number,state,labels']);
    const parsed = JSON.parse(raw);
    issues.push({
      number: parsed.number,
      state: 'OPEN' === parsed.state ? 'open' : 'closed',
      labels: (parsed.labels ?? []).map((label) => label.name),
    });
  } catch {
    unresolved.push(number);
  }
}

if (unresolved.length > 0) {
  console.log(
    `stale-issue guard: could not look up ${unresolved.map((n) => `#${n}`).join(', ')} — not judged.`,
  );
}

const stale = staleIssues(claimed, issues);
if (0 === stale.length) {
  console.log(`stale-issue guard: ${claimed.length} claimed issue(s), none left reading as open.`);
  process.exit(0);
}

console.error(`\n✗ ${staleIssueReport(stale)}\n`);
process.exit(1);

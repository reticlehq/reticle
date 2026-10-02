#!/usr/bin/env node
/**
 * A release cannot ship while `fixed-pending-release` is still on an open issue.
 *
 * The label means the fix is already on the release branch and the issue closes when the version
 * ships. 3.1.0 shipped with thirteen of them still open. Five had no fix on any branch: the label
 * had been applied from an unmerged pull request, and contributors walked past work that was not
 * done.
 *
 * This does not close anything and it does not remove the label. It refuses the publish until a
 * person has done one of those two things for every remaining issue. A release that cannot see the
 * list fails closed: skipping the check is how the last release shipped the lie.
 *
 * Usage: node scripts/check-pending-release.mjs
 *        node scripts/check-pending-release.mjs --self-test
 */

import { execFileSync } from 'node:child_process';

const LABEL = 'fixed-pending-release';

/**
 * Open issues that still wear the label.
 *
 * Closed issues are not outstanding. An issue that is open and unlabelled is somebody else's
 * problem. Only the combination the release promised to have finished is a blocker.
 */
export function pendingReleaseBlockers(issues) {
  if (!Array.isArray(issues)) return null;
  const blockers = [];
  for (const issue of issues) {
    if ('object' !== typeof issue || null === issue) return null;
    const number = issue.number;
    const state = issue.state;
    const labels = issue.labels;
    if ('number' !== typeof number || !Number.isInteger(number)) return null;
    if ('open' !== state && 'closed' !== state) return null;
    if (!Array.isArray(labels) || labels.some((label) => 'string' !== typeof label)) return null;
    if ('open' === state && labels.includes(LABEL)) blockers.push(number);
  }
  return blockers;
}

function selfTest() {
  const blocked = pendingReleaseBlockers([
    { number: 875, state: 'open', labels: ['bug', LABEL] },
    { number: 1, state: 'closed', labels: [LABEL] },
    { number: 2, state: 'open', labels: ['bug'] },
  ]);
  const clear = pendingReleaseBlockers([]);
  const refused = pendingReleaseBlockers([{ number: '875', state: 'open', labels: [] }]);
  if (
    null === blocked ||
    1 !== blocked.length ||
    875 !== blocked[0] ||
    null === clear ||
    0 !== clear.length ||
    null !== refused
  ) {
    console.error('pending-release check SELF-TEST FAILED');
    process.exit(1);
  }
  console.log('pending-release check self-test passed');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        'reticlehq/reticle',
        '--label',
        LABEL,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,state,labels',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(
      `pending-release check FAILED: could not list open issues wearing ${LABEL}. A release that cannot see the list does not ship.\n${detail}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('pending-release check FAILED: the issue list was not JSON.');
  }
  const blockers = pendingReleaseBlockers(
    Array.isArray(parsed)
      ? parsed.map((issue) => ({
          number: issue.number,
          state: 'open',
          labels: Array.isArray(issue.labels)
            ? issue.labels.map((label) => ('string' === typeof label ? label : label?.name))
            : issue.labels,
        }))
      : parsed,
  );
  if (null === blockers)
    fail('pending-release check FAILED: the issue list was not the shape this check reads.');
  if (0 < blockers.length) {
    const list = blockers.map((number) => `#${String(number)}`).join(', ');
    fail(
      `pending-release check FAILED: ${list} ${1 === blockers.length ? 'is' : 'are'} still open with \`${LABEL}\`. Close the ones whose fix is in this release, and remove the label from the ones whose fix is not. The label means the fix is on the release branch, not that a pull request exists.`,
    );
  }
  console.log(`pending-release check: no open issue wears ${LABEL}.`);
}

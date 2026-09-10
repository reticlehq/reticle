import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The final `gate` job is the one check a merge is allowed to depend on. It passes when every job it
 * lists in `needs` either succeeded or was skipped.
 *
 * Which makes the `needs` list load-bearing in a way that is easy to miss: a job that is NOT on it is
 * invisible to the aggregate. It can go red on every run, and the one required check still goes
 * green. The workflow says so in a comment -- "Adding a job to the workflow is half the work; this
 * line is the other half" -- and a comment is a thing you have to remember. This is the same rule
 * with a test behind it.
 *
 * The cost of getting it wrong is not theoretical for this repo. `rust` is the only job in CI that
 * compiles `packages/tauri` at all, because that package sits outside every JavaScript gate. While it
 * was missing from this list, a red Rust build merged clean.
 */

const CI_FILE = join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

/**
 * Jobs that are deliberately outside the aggregate, and why. Adding to this list is allowed; doing it
 * silently is not, which is the whole point of the list being here rather than in somebody's head.
 */
const OUTSIDE_THE_AGGREGATE: Record<string, string> = {
  // The aggregate itself. It cannot wait on its own result.
  gate: 'is the aggregate',
  // Fires a notification at another repository, only on a push to main, and reports failure without
  // ever failing -- the verdict it asks for lives in the other repo's run, not in this one. Nothing
  // about this PR is unproven if it does not fire.
  'fixtures-dispatch': 'notifies another repo; non-fatal by design, and never runs on a PR',
};

/** Every top-level job name in the workflow, in file order. */
function jobNames(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => 'jobs:' === line.trim());
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A top-level key at any indentation other than two spaces has left the jobs block.
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** The job names listed in the aggregate's `needs:` block. */
function aggregateNeeds(yaml: string): string[] {
  const afterGate = yaml.slice(yaml.indexOf('\n  gate:\n'));
  const needsAt = afterGate.indexOf('needs:');
  const block = afterGate.slice(needsAt, afterGate.indexOf(']', needsAt));
  return [...block.matchAll(/[a-z][a-z0-9-]*/g)]
    .map((m) => m[0])
    .filter((name) => 'needs' !== name);
}

describe('the aggregate gate covers every job', () => {
  const yaml = readFileSync(CI_FILE, 'utf8');
  const jobs = jobNames(yaml);
  const needs = aggregateNeeds(yaml);

  it('reads the workflow at all', () => {
    // Without this, a parser that returned nothing would make the real check below pass by having
    // nothing to check -- which is the exact failure shape this file exists to prevent.
    expect(jobs.length).toBeGreaterThan(5);
    expect(needs.length).toBeGreaterThan(5);
  });

  it('every job is watched by the aggregate, or listed as deliberately outside it', () => {
    const unwatched = jobs.filter(
      (job) => !needs.includes(job) && !Object.hasOwn(OUTSIDE_THE_AGGREGATE, job),
    );
    expect(
      unwatched,
      "These CI jobs can fail without failing the one required check. Add each to the `gate` job's " +
        '`needs:` list, or to OUTSIDE_THE_AGGREGATE in this file with the reason it is safe to ignore.',
    ).toEqual([]);
  });

  it('the aggregate does not wait on a job that no longer exists', () => {
    // A renamed or deleted job leaves a stale entry that GitHub resolves to nothing, quietly
    // shrinking what the required check covers.
    expect(needs.filter((name) => !jobs.includes(name))).toEqual([]);
  });
});

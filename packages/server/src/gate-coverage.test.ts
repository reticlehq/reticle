import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every CI job either blocks a merge or is declared here as one that deliberately does not.
 *
 * The `gate` job is the aggregate the branch protection points at: it fails if any job in its
 * `needs` reported anything but success or skipped. Which means a job ABSENT from that list runs,
 * reports, turns a PR's checks red-ish in the UI — and is structurally incapable of stopping a
 * merge. There is no signal distinguishing "wired up" from "not": both spellings run the job.
 *
 * This is not hypothetical. FOUR jobs were in that state at once — `windows`, `rust`, `rust-macos`
 * and `desktop-e2e`. `rust` is the sharpest case: it is the only thing in all of CI that compiles
 * `packages/tauri`, which sits outside every JS gate, so a red Rust build could merge clean. Each
 * was added to the workflow by somebody who reasonably believed adding it was the whole job.
 *
 * So the rule moves out of prose, for the reason every other rule in this repo did: the ones a
 * machine enforces have held and the ones left to discipline have not. Adding a job now forces a
 * decision — wire it into `gate`, or write down here why it may not block.
 *
 * The parse is deliberately crude (indentation, not YAML) because the file is hand-written and the
 * failure it guards is crude. A crude check that runs beats a correct one that needs a dependency.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '..', '..', '.github', 'workflows', 'ci.yml');

/** The aggregate job branch protection requires. Not itself in `needs`, obviously. */
const GATE_JOB = 'gate';

/**
 * Jobs that run but must NOT block a merge, each with the reason it is exempt.
 *
 * Being in this list is a claim that a red run here is acceptable to merge over. Two of the three
 * are advisory by nature; the third cannot block because it is what everything else is measured
 * against. Anything else added here deserves an argument in the PR that adds it.
 */
const NON_BLOCKING = new Map<string, string>([
  [
    'changes',
    'a path-filter fan-out that feeds other jobs. It fails OPEN on purpose — a broken filter must ' +
      'run MORE of CI, never silently less — so a failure here cannot mean "do not merge".',
  ],
  [
    'fixtures-dispatch',
    'fires a cross-repo dispatch on main only and is inert without FIXTURES_DISPATCH_TOKEN. It ' +
      'notifies; it does not verify. Tier 2 runs in another repository and cannot gate this one.',
  ],
]);

/** Top-level job keys: exactly two spaces of indent, under `jobs:`. */
function declaredJobs(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  expect(start, 'ci.yml must have a top-level `jobs:` key').toBeGreaterThanOrEqual(0);
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the jobs block.
    if (/^[a-zA-Z]/.test(line)) break;
    const match = /^ {2}([a-zA-Z][\w-]*):\s*$/.exec(line);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** The `needs: [...]` of the gate job, which this repo writes on one line. */
function gateNeeds(yaml: string): string[] {
  const block = new RegExp(`^ {2}${GATE_JOB}:$([\\s\\S]*?)^ {2}[a-zA-Z]`, 'm').exec(
    `${yaml}\n  end:`,
  );
  const body = block?.[1] ?? '';
  const needs = /^\s*needs:\s*\[([^\]]*)\]/m.exec(body);
  expect(needs?.[1], `the ${GATE_JOB} job must declare needs: [...]`).toBeDefined();
  return (needs?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

describe('every CI job can fail a merge, or says why it cannot', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');

  it('parses the workflow it is asserting about', () => {
    // Guards the check itself: a regex that silently matches nothing would pass every assertion
    // below while enforcing absolutely nothing, which is the same failure mode as the bug.
    const jobs = declaredJobs(yaml);
    expect(jobs.length).toBeGreaterThan(5);
    expect(jobs).toContain(GATE_JOB);
    expect(gateNeeds(yaml).length).toBeGreaterThan(0);
  });

  it('lists every job in gate.needs, or in the declared non-blocking set', () => {
    const needs = new Set(gateNeeds(yaml));
    const unwired = declaredJobs(yaml).filter(
      (job) => job !== GATE_JOB && !needs.has(job) && !NON_BLOCKING.has(job),
    );
    expect(
      unwired,
      `these CI jobs run but cannot fail a merge: ${unwired.join(', ')}. Add each to the ` +
        `'${GATE_JOB}' job's needs, or to NON_BLOCKING here with the reason it may not block.`,
    ).toEqual([]);
  });

  it('does not claim a job that no longer exists', () => {
    // The other direction: `needs` naming a deleted job makes the whole workflow invalid, and
    // NON_BLOCKING naming one is a stale exemption that would silently cover a future job reusing
    // the name.
    const jobs = new Set(declaredJobs(yaml));
    expect(gateNeeds(yaml).filter((job) => !jobs.has(job))).toEqual([]);
    expect([...NON_BLOCKING.keys()].filter((job) => !jobs.has(job))).toEqual([]);
  });
});

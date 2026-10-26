/**
 * A CI job's time limit must be longer than the limits of its own bounded steps.
 *
 * Incident: the merge queue cancelled the CI runs of #1620 and #1790. The `smoke` job allowed 10
 * minutes, but its Playwright install step allows 15 minutes and its retry another 15, so a slow
 * apt mirror killed the whole job at 10 minutes. The retry that was added to survive a slow mirror
 * never ran, and `gate` then failed the queue entry. `e2e` and `conformance` had the same gap.
 *
 * A step limit larger than its job's limit does nothing: the job limit always fires first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '@/machine/repo-root.js';

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

interface Step {
  'timeout-minutes'?: number;
}
interface Job {
  'timeout-minutes'?: number;
  steps?: Step[];
}

describe('each CI job has time for its own bounded steps', () => {
  const jobs = (parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, Job> }).jobs;

  it('reads jobs that bound their steps', () => {
    const bounded = Object.values(jobs).filter((job) =>
      (job.steps ?? []).some((step) => step['timeout-minutes'] !== undefined),
    );
    expect(bounded.length).toBeGreaterThan(0);
  });

  for (const [name, job] of Object.entries(jobs)) {
    const jobLimit = job['timeout-minutes'];
    if (jobLimit === undefined) {
      continue;
    }
    const stepLimits = (job.steps ?? []).reduce(
      (sum, step) => sum + (step['timeout-minutes'] ?? 0),
      0,
    );
    it(`${name}: job limit ${String(jobLimit)} min is longer than its steps' ${String(stepLimits)} min`, () => {
      expect(jobLimit).toBeGreaterThan(stepLimits);
    });
  }
});

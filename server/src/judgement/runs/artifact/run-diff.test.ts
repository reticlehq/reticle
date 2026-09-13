import { describe, expect, it } from 'vitest';
import {
  RunFlowStatus,
  VerdictStatus,
  type ReticleVerificationRun,
  type RunFlowResult,
} from '@reticlehq/core';
import { diffRuns } from './run-diff.js';

function flow(
  name: string,
  durationMs: number,
  status: string = RunFlowStatus.PASS,
): RunFlowResult {
  return { name, status: status as RunFlowResult['status'], steps: 1, durationMs };
}

/** Minimal run — diffRuns reads only flows + verdict.status, so a partial cast is safe for the test. */
function run(flows: RunFlowResult[], verdict: string = VerdictStatus.PASS): ReticleVerificationRun {
  return { flows, verdict: { status: verdict } } as unknown as ReticleVerificationRun;
}

describe('diffRuns', () => {
  it('reports a duration regression past the noise floor with the percent delta', () => {
    const diff = diffRuns(run([flow('checkout', 400)]), run([flow('checkout', 960)]));
    expect(diff.flows).toHaveLength(1);
    expect(diff.flows[0]).toMatchObject({
      name: 'checkout',
      durationDeltaMs: 560,
      durationDeltaPct: 140,
      regressed: true,
    });
    expect(diff.headline).toContain('checkout');
  });

  it('ignores duration jitter below the noise floor', () => {
    const diff = diffRuns(run([flow('checkout', 400)]), run([flow('checkout', 420)]));
    expect(diff.flows).toEqual([]);
    expect(diff.headline).toContain('no significant change');
  });

  it('always surfaces a status change even with no duration change', () => {
    const diff = diffRuns(
      run([flow('checkout', 400, RunFlowStatus.PASS)]),
      run([flow('checkout', 400, RunFlowStatus.FAIL)]),
    );
    expect(diff.flows[0]).toMatchObject({ statusChanged: true, regressed: true });
  });

  it('reports new and removed flows', () => {
    const diff = diffRuns(
      run([flow('a', 100), flow('b', 100)]),
      run([flow('a', 100), flow('c', 100)]),
    );
    expect(diff.newFlows).toEqual(['c']);
    expect(diff.removedFlows).toEqual(['b']);
  });

  it('reports a verdict change', () => {
    const diff = diffRuns(run([], VerdictStatus.PASS), run([], VerdictStatus.FAIL));
    expect(diff.verdictChange).toEqual({ from: 'pass', to: 'fail' });
    expect(diff.headline).toContain('pass→fail');
  });

  it('ranks the worst regression first', () => {
    const diff = diffRuns(
      run([flow('a', 100), flow('b', 100)]),
      run([flow('a', 130), flow('b', 300)]),
    );
    expect(diff.flows[0]?.name).toBe('b');
  });
});

import { describe, expect, it } from 'vitest';
import { RunFlowStatus, ScreenshotSource, type ReticleVerificationRun } from '@reticlehq/core';
import { withScreenshots } from './run-store.js';

/** A run lists every picture it took, and pins each to the step or check it is a picture of. */

const shot = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  file: `000${String(seq)}-x.jpg`,
  tool: 'reticle_act_and_wait',
  source: ScreenshotSource.BROWSER,
  width: 10,
  height: 10,
  sha256: String(seq).repeat(64).slice(0, 64),
  ...extra,
});

const run = (checks: number): ReticleVerificationRun =>
  ({
    runId: 'r',
    checks: Array.from({ length: checks }, (_, i) => ({
      predicate: `claim ${String(i)}`,
      status: 'yes',
      checkId: `c${String(i + 1)}`,
    })),
    flows: [
      {
        name: 'checkout',
        status: RunFlowStatus.PASS,
        steps: 1,
        durationMs: 1,
        stepResults: [{ step: 0, anchor: 'pay', ok: true }],
      },
    ],
  }) as unknown as ReticleVerificationRun;

describe('withScreenshots', () => {
  it('pairs the n-th verdict picture with the n-th check, and a replay picture with its step', () => {
    const out = withScreenshots(run(2), [
      shot(1, { tool: 'reticle_navigate' }),
      shot(2, { verdict: true }),
      shot(3, { verdict: true }),
      shot(4, { step: 'checkout#0' }),
    ]);

    expect(out.screenshots?.map((s) => s.checkId)).toEqual([undefined, 'c1', 'c2', undefined]);
    expect(out.checks.map((c) => c.screenshot?.file)).toEqual(['0002-x.jpg', '0003-x.jpg']);
    expect(out.flows[0]?.stepResults?.[0]?.screenshot?.file).toBe('0004-x.jpg');
  });

  it('pairs nothing when the counts disagree, rather than pin a picture to the wrong check', () => {
    const out = withScreenshots(run(2), [shot(1, { verdict: true })]);

    expect(out.screenshots?.[0]?.checkId).toBeUndefined();
    expect(out.checks.every((c) => c.screenshot === undefined)).toBe(true);
  });
});

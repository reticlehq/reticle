import { describe, expect, it } from 'vitest';
import { agentUrl, gradeParallelCell } from './parallel-agents-cell.mjs';

/**
 * The 2-agent parallel cell: two agents on one daemon, each in its own tab, replay one flow at the
 * same time. Agent B's tab carries the bug, agent A's does not. If a verdict crosses tabs, A fails or
 * B passes. The cell also prices the parallel path: A's tokens in parallel against A's tokens alone.
 */
const ok = { status: 'ok', successOk: true, drifted: false, tokens: 400 };
const caught = { status: 'failed', successOk: false, drifted: false, tokens: 420 };

describe('agentUrl', () => {
  it('gives each agent its own URL, so each adapter pins its own tab', () => {
    const a = agentUrl('http://localhost:4312/', 'a');
    const b = agentUrl('http://localhost:4312/', 'b');
    expect(a).not.toBe(b);
    expect(a.startsWith('http://localhost:4312/')).toBe(true);
    expect(new URL(b).searchParams.get('bench-agent')).toBe('b');
  });

  it('adds the bug only when asked', () => {
    expect(new URL(agentUrl('http://localhost:4312/', 'a')).searchParams.has('reticle-bug')).toBe(
      false,
    );
    expect(
      new URL(agentUrl('http://localhost:4312/', 'b', 'console-leak')).searchParams.get(
        'reticle-bug',
      ),
    ).toBe('console-leak');
  });
});

describe('gradeParallelCell', () => {
  it('is correct when A holds alone and in parallel, and B is caught in parallel', () => {
    const g = gradeParallelCell({ solo: ok, parallelA: { ...ok, tokens: 440 }, parallelB: caught });
    expect(g.correct).toBe(true);
    expect(g.cross_talk).toBe(false);
    expect(g.parallel_token_overhead_pct).toBe(10);
  });

  it('calls it cross-talk when B passes, or A fails, in parallel', () => {
    expect(gradeParallelCell({ solo: ok, parallelA: ok, parallelB: ok }).cross_talk).toBe(true);
    expect(gradeParallelCell({ solo: ok, parallelA: caught, parallelB: caught }).cross_talk).toBe(
      true,
    );
  });

  it('is not correct when the solo run did not hold: the cell measured nothing', () => {
    const g = gradeParallelCell({ solo: caught, parallelA: ok, parallelB: caught });
    expect(g.correct).toBe(false);
    expect(g.cross_talk).toBe(false);
  });

  it('does not count a drifted replay as caught: the bug is the console, not a missing step', () => {
    const drifted = { ...caught, drifted: true };
    expect(gradeParallelCell({ solo: ok, parallelA: ok, parallelB: drifted }).correct).toBe(false);
  });

  it('reports no overhead when a token count is missing, rather than a false number', () => {
    const g = gradeParallelCell({
      solo: { ...ok, tokens: null },
      parallelA: ok,
      parallelB: caught,
    });
    expect(g.parallel_token_overhead_pct).toBeNull();
  });
});

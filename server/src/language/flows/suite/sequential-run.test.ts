import { describe, expect, it } from 'vitest';
import { SuiteStopReason, SuiteVerdictStatus } from '@reticlehq/core';
import { DEFAULT_SUITE_BUDGET_MS, runSequentially, withStop } from './sequential-run.js';

/** A clock that only moves when a flow "takes time". */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('runSequentially', () => {
  it('runs every flow when the budget holds and the session stays up', async () => {
    const clock = fakeClock();
    const ran: string[] = [];
    const out = await runSequentially(['a', 'b', 'c'], {
      now: clock.now,
      budgetMs: 1000,
      sessionAlive: () => true,
      run: (name) => {
        ran.push(name);
        clock.advance(100);
        return Promise.resolve(name);
      },
    });
    expect(out.results).toEqual(['a', 'b', 'c']);
    expect(out.notRun).toEqual([]);
    expect(out.stopped).toBeUndefined();
  });

  it('stops starting flows once the total budget is spent, naming the rest', async () => {
    const clock = fakeClock();
    const ran: string[] = [];
    const out = await runSequentially(['a', 'b', 'c', 'd'], {
      now: clock.now,
      budgetMs: 250,
      sessionAlive: () => true,
      run: (name) => {
        ran.push(name);
        clock.advance(100);
        return Promise.resolve(name);
      },
    });
    // a: 0-100, b: 100-200, c starts at 200 (< 250) and ends at 300, d is not started.
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(out.notRun).toEqual(['d']);
    expect(out.stopped?.reason).toBe(SuiteStopReason.TIME_BUDGET);
    expect(out.stopped?.budgetMs).toBe(250);
  });

  it('always starts the first flow, even with a spent budget', async () => {
    const clock = fakeClock();
    const out = await runSequentially(['a', 'b'], {
      now: clock.now,
      budgetMs: 0,
      sessionAlive: () => true,
      run: (name) => Promise.resolve(name),
    });
    expect(out.results).toEqual(['a']);
    expect(out.notRun).toEqual(['b']);
  });

  it('stops at once when the session is lost, naming the flow that lost it', async () => {
    const clock = fakeClock();
    let alive = true;
    const ran: string[] = [];
    const out = await runSequentially(['a', 'b', 'c', 'd'], {
      now: clock.now,
      budgetMs: DEFAULT_SUITE_BUDGET_MS,
      sessionAlive: () => alive,
      run: (name) => {
        ran.push(name);
        if ('b' === name) {
          alive = false;
        }
        return Promise.resolve(name);
      },
    });
    expect(ran).toEqual(['a', 'b']);
    expect(out.results).toEqual(['a', 'b']);
    expect(out.notRun).toEqual(['c', 'd']);
    expect(out.stopped?.reason).toBe(SuiteStopReason.SESSION_LOST);
    expect(out.stopped?.flow).toBe('b');
    expect(out.stopped?.nextAction).toMatch(/reconnect/);
  });

  it('does not call a session lost on the last flow: nothing is left unrun', async () => {
    const out = await runSequentially(['a'], {
      now: () => 0,
      budgetMs: 1000,
      sessionAlive: () => false,
      run: (name) => Promise.resolve(name),
    });
    expect(out.stopped).toBeUndefined();
  });
});

describe('withStop', () => {
  const base = { status: SuiteVerdictStatus.PASS, summary: 'all 2 flows pass' };

  it('leaves a complete suite untouched', () => {
    expect(withStop(base, [], undefined)).toBe(base);
  });

  it('reports a partial suite, leading with what did not run', () => {
    const out = withStop(base, ['c', 'd'], {
      reason: SuiteStopReason.SESSION_LOST,
      flow: 'b',
      nextAction: 'reconnect',
    });
    expect(out.status).toBe('partial');
    expect(out.notRun).toEqual(['c', 'd']);
    expect(out.summary).toMatch(/^PARTIAL .*"b".*2 flow\(s\) did not run \(c, d\)/);
    expect(out.summary).toContain('all 2 flows pass');
  });
});

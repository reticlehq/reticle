import { describe, expect, it, vi } from 'vitest';
import { runSpecs, runOne } from './runner.js';
import { IrisSkip } from './skip.js';
import { TestStatus } from './constants.js';
import type { ToolInvoker } from '@syrin/iris-server';
import type { IrisSpec, RunnerOptions, SpecContext } from './types.js';

/** A fake invoker that records every call and returns canned results keyed by tool name. */
function fakeInvoker(canned: Record<string, unknown> = {}): {
  invoke: ToolInvoker;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const invoke: ToolInvoker = (tool, args) => {
    calls.push({ tool, args });
    return Promise.resolve(canned[tool]);
  };
  return { invoke, calls };
}

/** A monotonic clock scripted by a list of ms values; falls back to the last value. */
function scriptedClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

/** The per-spec `t`: an opaque context the runner passes through. Tests use a trivial one. */
function buildContext(invoke: ToolInvoker): SpecContext {
  return { invoke };
}

function options(overrides: Partial<RunnerOptions>): RunnerOptions {
  const { invoke } = fakeInvoker();
  return {
    invoke,
    buildContext,
    now: scriptedClock([0, 1]),
    specs: [],
    ...overrides,
  };
}

describe('runSpecs', () => {
  it('a passing spec reports status pass', async () => {
    const spec: IrisSpec = { name: 'ok', fn: () => undefined };
    const { results } = await runSpecs(
      options({ specs: [spec], now: scriptedClock([1000, 1042]) }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ name: 'ok', status: TestStatus.PASS, durationMs: 42 });
    expect(results[0]).not.toHaveProperty('error');
    expect(results[0]).not.toHaveProperty('skipReason');
  });

  it('runs specs in registration order', async () => {
    const order: string[] = [];
    const mk = (n: string): IrisSpec => ({
      name: n,
      fn: () => {
        order.push(n);
      },
    });
    const { results } = await runSpecs(options({ specs: [mk('a'), mk('b'), mk('c')] }));
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('durationMs comes from the injected clock, never Date.now', async () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const spec: IrisSpec = { name: 'd', fn: () => undefined };
    const { results } = await runSpecs(options({ specs: [spec], now: scriptedClock([100, 350]) }));
    expect(results[0]?.durationMs).toBe(250);
    expect(dateSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it('each spec gets a fresh t built from the invoker', async () => {
    const { invoke, calls } = fakeInvoker({ iris_act: { inputMode: 'real' } });
    const mk = (n: string): IrisSpec => ({
      name: n,
      fn: async (t) => {
        await t.invoke('iris_act', { n });
      },
    });
    await runSpecs(options({ specs: [mk('a'), mk('b')], invoke }));
    expect(calls).toEqual([
      { tool: 'iris_act', args: { n: 'a' } },
      { tool: 'iris_act', args: { n: 'b' } },
    ]);
  });

  it('a throwing spec reports status fail with the error message', async () => {
    const spec: IrisSpec = {
      name: 'boom',
      fn: () => {
        throw new Error('boom');
      },
    };
    const { results } = await runSpecs(options({ specs: [spec], now: scriptedClock([0, 5]) }));
    expect(results[0]?.status).toBe(TestStatus.FAIL);
    expect(results[0]?.error).toBe('boom');
    expect(results[0]?.durationMs).toBe(5);
  });

  it('a spec rejecting a promise reports fail', async () => {
    const spec: IrisSpec = { name: 'async', fn: () => Promise.reject(new Error('async boom')) };
    const { results } = await runSpecs(options({ specs: [spec] }));
    expect(results[0]?.status).toBe(TestStatus.FAIL);
    expect(results[0]?.error).toBe('async boom');
  });

  it('a non-Error throw is stringified into error', async () => {
    const spec: IrisSpec = {
      name: 'plain',
      fn: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a non-Error throw
        throw 'plain string';
      },
    };
    const { results } = await runSpecs(options({ specs: [spec] }));
    expect(results[0]?.status).toBe(TestStatus.FAIL);
    expect(results[0]?.error).toBe('plain string');
  });

  it('a failing assertion reports fail with the failure reason in error', async () => {
    const spec: IrisSpec = {
      name: 'assert',
      fn: () => {
        throw new Error('no signal');
      },
    };
    const { results } = await runSpecs(options({ specs: [spec] }));
    expect(results[0]?.status).toBe(TestStatus.FAIL);
    expect(results[0]?.error).toContain('no signal');
  });

  it('an empty registry returns an empty result set', async () => {
    const { results, summary } = await runSpecs(options({ specs: [] }));
    expect(results).toHaveLength(0);
    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(0);
  });

  it('a spec that skips reports status skip with reason', async () => {
    const spec: IrisSpec = {
      name: 'skipme',
      fn: () => {
        throw new IrisSkip('real input not active');
      },
    };
    const { results } = await runSpecs(options({ specs: [spec] }));
    expect(results[0]?.status).toBe(TestStatus.SKIP);
    expect(results[0]?.skipReason).toBe('real input not active');
    expect(results[0]).not.toHaveProperty('error');
  });

  it('one spec failing does not abort the remaining specs', async () => {
    const mk = (n: string, throws: boolean): IrisSpec => ({
      name: n,
      fn: () => {
        if (throws) throw new Error(n);
      },
    });
    const { results } = await runSpecs(
      options({ specs: [mk('a', false), mk('b', true), mk('c', false)] }),
    );
    expect(results.map((r) => r.status)).toEqual([
      TestStatus.PASS,
      TestStatus.FAIL,
      TestStatus.PASS,
    ]);
  });

  it('duplicate spec names are kept, not collapsed', async () => {
    const mk = (): IrisSpec => ({ name: 'x', fn: () => undefined });
    const { results } = await runSpecs(options({ specs: [mk(), mk()] }));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.name === 'x')).toBe(true);
  });
});

describe('runOne', () => {
  it('measures duration and classifies a pass', async () => {
    const result = await runOne(
      { name: 'one', fn: () => undefined },
      options({ now: scriptedClock([10, 20]) }),
    );
    expect(result).toEqual({ name: 'one', status: TestStatus.PASS, durationMs: 10 });
  });
});

import { describe, expect, it } from 'vitest';
import type { FlowReplayResult } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { persistLearning, persistSources } from './flow-learning.js';

/**
 * What a replay learns reaches the flow file — asserted by CALLING it, not by reading its source.
 *
 * The first version of this test read `flow-learning.ts` with `readFileSync` and asserted
 * `toContain('recordLearned(')`. It was a false green, and it was proved so by mutation: commenting
 * the real call out and leaving the name in the comment kept the test at 6 of 6.
 *
 * That is the failure this repository has already written down once — a source string-match went
 * green because a comment quoted the code it replaced — and writing it again, in a test whose whole
 * purpose was to catch a built-and-unwired feature, is worse than not having written the test. A
 * check that cannot fail is a claim of safety that is not true.
 *
 * So this drives the seam: a fake store records what it was asked to do, and the assertions are
 * about behaviour. `recordLearned` could be renamed, moved, or inlined and these still hold; it
 * could be deleted and they all go red.
 */
interface Recorded {
  readonly name: string;
  readonly learned: unknown;
}

function depsThatRecord(): { deps: ToolDeps; calls: Recorded[]; wideSaves: number } {
  const calls: Recorded[] = [];
  const state = { wideSaves: 0 };
  const flows = {
    recordLearned: (name: string, learned: unknown) => {
      calls.push({ name, learned });
      return Promise.resolve({ ok: true, value: { name } });
    },
    // The wide writer must NOT be used here: it re-runs intent linking over the whole document and
    // reverted a discharged intent the first time this was wired. Counted so the test can say so.
    saveFlow: () => {
      state.wideSaves += 1;
      return Promise.resolve({ ok: true, value: {} });
    },
    load: () => Promise.resolve({ ok: true, value: { name: 'demo', steps: [] } }),
  };
  const deps = {
    flows,
    reticleRoot: '/tmp/none',
    sessions: {
      resolve: () => ({ projectId: undefined }),
    },
  } as unknown as ToolDeps;
  return {
    deps,
    calls,
    get wideSaves() {
      return state.wideSaves;
    },
  };
}

const result = (learned: FlowReplayResult['learned']): FlowReplayResult =>
  ({ status: 'ok', learned }) as FlowReplayResult;

describe('learning reaches the flow file', () => {
  it('writes what the replay learned, under the flow that was replayed', async () => {
    const { deps, calls } = depsThatRecord();
    const learned = [{ kind: 'request-never-settled', step: 2, state: 'guarded' as const }];
    await persistLearning(deps, { flowName: 'checkout' }, result(learned));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('checkout');
    expect(calls[0]?.learned).toEqual(learned);
  });

  it('never uses the WIDE writer — that reverted a discharged intent', async () => {
    const recorder = depsThatRecord();
    await persistLearning(
      recorder.deps,
      { flowName: 'checkout' },
      result([{ kind: 'x', step: 0, state: 'open' }]),
    );
    expect(recorder.wideSaves, 'saveFlow re-runs intent linking over the whole document').toBe(0);
  });

  it('writes nothing when the replay learned nothing', async () => {
    const { deps, calls } = depsThatRecord();
    await persistLearning(deps, { flowName: 'checkout' }, result([]));
    await persistLearning(deps, { flowName: 'checkout' }, result(undefined));
    expect(calls).toHaveLength(0);
  });

  it('writes nothing when there is no flow name to write under', async () => {
    const { deps, calls } = depsThatRecord();
    await persistLearning(deps, {}, result([{ kind: 'x', step: 0, state: 'open' }]));
    expect(calls).toHaveLength(0);
  });

  it('returns the replay result unchanged, whatever the write does', async () => {
    // Bookkeeping must never alter the verdict, and must never turn a completed replay into a
    // failed one — so a throwing store is swallowed and the caller still gets its answer.
    const throwing = {
      flows: {
        recordLearned: () => Promise.reject(new Error('disk full')),
        load: () => Promise.resolve({ ok: true, value: { name: 'demo', steps: [] } }),
      },
      reticleRoot: '/tmp/none',
      sessions: { resolve: () => ({ projectId: undefined }) },
    } as unknown as ToolDeps;
    const r = result([{ kind: 'x', step: 0, state: 'open' }]);
    await expect(persistLearning(throwing, { flowName: 'checkout' }, r)).resolves.toBe(r);
  });
});

describe('sources a clean replay resolved reach the flow file', () => {
  const pay = { tool: 'reticle_act', anchor: { kind: 'testid', value: 'pay' }, action: 'click' };
  const sources = new Map([['["testid","pay",null]', { file: 'src/Pay.tsx', line: 12 }]]);

  function store(steps: unknown[]): { deps: ToolDeps; written: string[] } {
    const written: string[] = [];
    const deps = {
      flows: {
        load: () => Promise.resolve({ ok: true, value: { name: 'checkout', steps } }),
        recordSources: (name: string) => {
          written.push(name);
          return Promise.resolve({ ok: true, value: { name } });
        },
      },
      reticleRoot: '/tmp/none',
      sessions: { resolve: () => ({ projectId: undefined }) },
    } as unknown as ToolDeps;
    return { deps, written };
  }

  it('writes a sourceless step the file its anchor resolved to', async () => {
    const { deps, written } = store([pay]);
    await persistSources(deps, { flowName: 'checkout' }, sources);
    expect(written).toEqual(['checkout']);
  });

  it('never rewrites a flow whose steps already name their files', async () => {
    const { deps, written } = store([{ ...pay, source: { file: 'src/Pay.tsx', line: 12 } }]);
    await persistSources(deps, { flowName: 'checkout' }, sources);
    expect(written).toEqual([]);
  });
});

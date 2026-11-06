import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { LEASE_COVERAGE_TOOL } from './lease-coverage-tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from './tools.js';
import type { ScriptCoverage } from '@/portal/input/js-coverage.js';

interface FakeCoverage {
  started: number;
  running: boolean;
  takes: (ScriptCoverage[] | undefined)[];
  canStart: boolean;
}

function fake(over: Partial<FakeCoverage> = {}): FakeCoverage {
  return { started: 0, running: true, takes: [], canStart: true, ...over };
}

function depsWith(coverage: FakeCoverage | undefined): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ id: 'lease-1', url: 'http://localhost:5173/' }) as never,
  };
  const jsCoverage =
    coverage === undefined
      ? undefined
      : {
          start: (): Promise<boolean> => {
            coverage.started += 1;
            coverage.running = coverage.canStart;
            return Promise.resolve(coverage.canStart);
          },
          take: (): Promise<ScriptCoverage[] | undefined> =>
            Promise.resolve(coverage.running ? coverage.takes.shift() : undefined),
        };
  return {
    sessions,
    pool: { coverageOf: (id: string) => ('lease-1' === id ? jsCoverage : undefined) },
  } as unknown as ToolDeps;
}

const script = (url: string, ranges: [number, number, number][]): ScriptCoverage => ({
  url,
  functions: [
    {
      functionName: '',
      ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })),
    },
  ],
});

const run = (deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> =>
  LEASE_COVERAGE_TOOL.handler(deps, args);

describe('reticle_lease { action: "coverage" }', () => {
  it('is the lease member it says it is', () => {
    expect(LEASE_COVERAGE_TOOL.name).toBe(ReticleTool.LEASE_COVERAGE);
  });

  it('starts coverage on the leased page', async () => {
    const coverage = fake({ running: false });
    expect(await run(depsWith(coverage), { mode: 'start' })).toEqual({ running: true });
    expect(coverage.started).toBe(1);
  });

  it('takes the block ranges of each script, flattened, with nothing lost', async () => {
    const coverage = fake({
      takes: [
        [
          script('http://a/app.js', [
            [0, 90, 1],
            [10, 20, 0],
          ]),
          script('http://a/v.js', []),
        ],
      ],
    });
    expect(await run(depsWith(coverage), { mode: 'take' })).toEqual({
      running: true,
      scripts: [
        {
          url: 'http://a/app.js',
          ranges: [
            { startOffset: 0, endOffset: 90, count: 1 },
            { startOffset: 10, endOffset: 20, count: 0 },
          ],
        },
        { url: 'http://a/v.js', ranges: [] },
      ],
      scriptCount: 2,
      rangeCount: 2,
    });
  });

  it('keeps only the scripts whose url contains urlContains, and says how many it left out', async () => {
    const coverage = fake({
      takes: [
        [
          script('http://a/src/app.js', [[0, 9, 1]]),
          script('http://a/node_modules/x.js', [[0, 9, 1]]),
        ],
      ],
    });
    const res = (await run(depsWith(coverage), { urlContains: '/src/' })) as Record<
      string,
      unknown
    >;
    expect(res['scripts']).toEqual([
      { url: 'http://a/src/app.js', ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] },
    ]);
    expect(res['filteredOut']).toBe(1);
    expect(res['truncated']).toBeUndefined();
  });

  it('declares the ranges it dropped at the cap, so a partial answer never reads as whole', async () => {
    const coverage = fake({
      takes: [
        [
          script('http://a/a.js', [
            [0, 1, 1],
            [1, 2, 1],
            [2, 3, 1],
          ]),
          script('http://a/b.js', [[0, 1, 1]]),
        ],
      ],
    });
    const res = (await run(depsWith(coverage), { maxRanges: 2 })) as Record<string, unknown>;
    expect(res['rangeCount']).toBe(2);
    expect(res['truncated']).toEqual({ ranges: 2, scripts: 1, maxRanges: 2 });
    expect(res['scripts']).toEqual([
      {
        url: 'http://a/a.js',
        ranges: [
          { startOffset: 0, endOffset: 1, count: 1 },
          { startOffset: 1, endOffset: 2, count: 1 },
        ],
      },
    ]);
  });

  it('starts coverage on a take when it was not running, and says the take holds nothing', async () => {
    const coverage = fake({ running: false });
    const res = (await run(depsWith(coverage), {})) as Record<string, unknown>;
    expect(res['running']).toBe(true);
    expect(res['scripts']).toEqual([]);
    expect(String(res['hint'])).toMatch(/was not running/);
  });

  it('refuses by name when the page cannot measure coverage', async () => {
    await expect(run(depsWith(fake({ running: false, canStart: false })), {})).rejects.toThrow(
      /cannot measure/,
    );
  });

  it('refuses by name on a session that is not a lease', async () => {
    await expect(run(depsWith(undefined), {})).rejects.toThrow(/leased/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayStatus, type FlowReplayResult, type SuiteVerdict } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tools.js';

/** Flows replayed so far, in order — the mocked replay appends, the fake session reads. */
const replayed: string[] = [];

vi.mock('../../judgement/runs/verification-sync.js', () => ({
  persistAndSyncVerificationRun: (): Promise<string> => Promise.resolve('run-id-001'),
}));

vi.mock('./flow-replay-run.js', () => ({
  replayNamedFlow: (_deps: unknown, args: Record<string, unknown>): Promise<FlowReplayResult> => {
    replayed.push(args['flowName'] as string);
    return Promise.resolve({
      name: args['flowName'] as string,
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: 'click', anchor: 'button', ok: true }],
    });
  },
  sessionProjectId: () => 'proj-123',
  flowErrorMessage: () => 'error',
  latestRecordedFlow: () => undefined,
}));

vi.mock('./suite/server-verify.js', () => ({
  runServerVerify: () => Promise.resolve(null),
}));

vi.mock('../../memory/cloud/cloud-config.js', () => ({
  resolveProjectCloud: () =>
    Promise.resolve({ config: null, policy: { memory: false, runs: false } }),
}));

const { FLOW_TOOLS } = await import('./flow-tools.js');

/**
 * `reticle_verify { action: "flows" }` on the shared-session path must stop on its own: when the
 * browser session disappears part-way through, and when a total time budget is spent. The pure loop
 * is covered in `suite/sequential-run.test.ts`; this drives the HANDLER, so removing the wiring in
 * `flow-tools.ts` (the budget argument, the session probe, the `partial` verdict) turns it red.
 */
describe('sequential flow_verify stops instead of running out the MCP client timeout', () => {
  const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
  if (verify === undefined) {
    throw new Error('flow_verify not found in FLOW_TOOLS');
  }

  let clock: number;
  let sessionGoneAfter: number;
  let deps: ToolDeps;

  beforeEach(() => {
    replayed.length = 0;
    clock = 1000;
    sessionGoneAfter = Number.POSITIVE_INFINITY;
    deps = {
      now: () => clock,
      fs: { readFile: () => Promise.reject(new Error('no')), writeFile: () => Promise.resolve() },
      reticleRoot: '/tmp/reticle-test/.reticle',
      sessions: {
        resolve: () => {
          if (replayed.length >= sessionGoneAfter) {
            throw new Error('session lost');
          }
          return { id: 's1', url: 'http://localhost:3000/app', projectId: 'proj-123' };
        },
        get: () => ({}),
      },
      flows: {
        list: () => Promise.resolve(['a', 'b', 'c', 'd']),
        load: () => Promise.resolve({ ok: true, value: { steps: [], success: undefined } }),
      },
      project: { recordRun: () => Promise.resolve() },
    } as unknown as ToolDeps;
  });

  it('a session that vanishes after the first flow yields partial with the rest in notRun', async () => {
    sessionGoneAfter = 1;
    const verdict = (await verify.handler(deps, {})) as SuiteVerdict;
    expect(replayed).toEqual(['a']);
    expect(verdict.status).toBe('partial');
    expect(verdict.notRun).toEqual(['b', 'c', 'd']);
    expect(verdict.stopped).toMatchObject({ reason: 'session_lost', flow: 'a' });
  });

  it('a spent budget stops before the next flow, and the first flow always runs', async () => {
    // Each replay advances the fake clock past the budget.
    deps.now = () => (clock += 500);
    const verdict = (await verify.handler(deps, { budgetMs: 1 })) as SuiteVerdict;
    expect(replayed).toEqual(['a']);
    expect(verdict.status).toBe('partial');
    expect(verdict.notRun).toEqual(['b', 'c', 'd']);
    expect(verdict.stopped).toMatchObject({ reason: 'time_budget', budgetMs: 1 });
  });

  it('a healthy session within budget runs every flow and is not partial', async () => {
    const verdict = (await verify.handler(deps, {})) as SuiteVerdict;
    expect(replayed).toEqual(['a', 'b', 'c', 'd']);
    expect(verdict.status).not.toBe('partial');
    expect(verdict.notRun).toBeUndefined();
  });
});

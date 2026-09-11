import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import type { ToolDeps } from '../tools/tools.js';

const persistSpy = vi.fn().mockResolvedValue('run-id-001');

vi.mock('../runs/verification-sync.js', () => ({
  persistAndSyncVerificationRun: (...args: unknown[]): Promise<string> =>
    persistSpy(...args) as Promise<string>,
}));

vi.mock('./flow-replay-run.js', () => ({
  replayNamedFlow: (_deps: unknown, args: Record<string, unknown>): Promise<FlowReplayResult> =>
    Promise.resolve({
      name: (args['flowName'] as string) ?? '',
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: 'click', anchor: 'button', ok: true }],
    }),
  sessionProjectId: () => 'proj-123',
  flowErrorMessage: () => 'error',
  latestRecordedFlow: () => undefined,
}));

vi.mock('./server-verify.js', () => ({
  runServerVerify: () => Promise.resolve(null),
}));

vi.mock('../cloud/cloud-config.js', () => ({
  resolveProjectCloud: () =>
    Promise.resolve({ config: null, policy: { memory: false, runs: false } }),
}));

const { FLOW_TOOLS } = await import('./flow-tools.js');

/**
 * The parallel path in `flow_verify` must persist a `ReticleVerificationRun` artifact — the same one
 * the sequential path produces. Without it, teams using `parallel:N` get zero entries in the Runs tab
 * and `reticle_run_export` returns nothing.
 *
 * This wiring test drives the handler with a mocked pool and asserts the persist call fires with the
 * correct `TimedReplay[]` shape. It does NOT test the content of the artifact (that's in
 * verification-sync.test.ts) — only that the parallel path calls the function at all.
 */
describe('parallel flow_verify persists a verification run artifact', () => {
  const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
  if (verify === undefined) throw new Error('flow_verify not found in FLOW_TOOLS');

  let deps: ToolDeps;

  beforeEach(() => {
    persistSpy.mockClear();
    const fakePool = {
      acquire: (_url: string, opts: { sessionId: string }) =>
        Promise.resolve({ sessionId: opts.sessionId, release: () => Promise.resolve() }),
      capacity: () => 4,
      activeCount: () => 0,
      queuedCount: () => 0,
    };
    deps = {
      pool: fakePool,
      now: (() => {
        let t = 1000;
        return () => (t += 50);
      })(),
      fs: { readFile: () => Promise.reject(new Error('no')), writeFile: () => Promise.resolve() },
      reticleRoot: '/tmp/reticle-test/.reticle',
      sessions: {
        resolve: () => ({ url: 'http://localhost:3000/app', projectId: 'proj-123' }),
        get: () => ({}),
      },
      flows: {
        list: () => Promise.resolve(['checkout', 'login']),
        load: () => Promise.resolve({ ok: true, value: { steps: [], success: undefined } }),
      },
      project: { recordRun: () => Promise.resolve() },
    } as unknown as ToolDeps;
  });

  it('calls persistAndSyncVerificationRun when the parallel path runs', async () => {
    const result = await verify.handler(deps, { parallel: 2 });
    expect(persistSpy).toHaveBeenCalledOnce();
    const [, timed, projectId] = persistSpy.mock.calls[0] as [unknown, unknown[], string];
    expect(projectId).toBe('proj-123');
    expect(timed).toHaveLength(2);
    expect(result).toHaveProperty('status');
  });

  it('builds TimedReplay[] with durationMs from the injected clock', async () => {
    await verify.handler(deps, { parallel: 2, names: ['checkout'] });
    const [, timed] = persistSpy.mock.calls[0] as [unknown, Array<{ durationMs: number }>];
    expect(timed[0]?.durationMs).toBeGreaterThan(0);
  });

  it('passes projectId to acquireLeasedSession so leased tabs carry __reticle_project', async () => {
    const acquireUrls: string[] = [];
    const fakePool = {
      acquire: (url: string, opts: { sessionId: string }) => {
        acquireUrls.push(url);
        return Promise.resolve({ sessionId: opts.sessionId, release: () => Promise.resolve() });
      },
      capacity: () => 4,
      activeCount: () => 0,
      queuedCount: () => 0,
    };
    (deps as unknown as Record<string, unknown>)['pool'] = fakePool;
    await verify.handler(deps, { parallel: 2, names: ['checkout'] });
    expect(acquireUrls[0]).toContain('__reticle_project=proj-123');
  });
});

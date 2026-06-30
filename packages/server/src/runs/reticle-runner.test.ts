import { describe, expect, it } from 'vitest';
import {
  asRunId,
  ReplayStatus,
  RiskSurface,
  RunAgentKind,
  RunChangeKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type FlowReplayResult,
} from '@reticle/protocol';
import { ReticleRunner, type RunnerPort, type VerifyOptions } from './reticle-runner.js';

const replay = (
  name: string,
  status: ReplayStatus,
  extra?: Partial<FlowReplayResult>,
): FlowReplayResult => ({
  name,
  status,
  steps: [],
  ...extra,
});

/** A fake port: a fixed flow→replay map, a monotonic clock, and a counter-based run id. No CDP. */
function fakePort(replays: Record<string, FlowReplayResult>, names: string[]): RunnerPort {
  const map = new Map(Object.entries(replays));
  let t = 1000;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(names),
    replayFlow: (name) => {
      const r = map.get(name);
      return r === undefined
        ? Promise.reject(new Error(`no fake replay for ${name}`))
        : Promise.resolve(r);
    },
    now: () => (t += 1),
    newRunId: () => asRunId(`run-${(n += 1)}`),
  };
}

const opts: Omit<VerifyOptions, 'names'> = {
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'pipeline', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  profile: RunProfile.PROD_PREVIEW,
};

describe('ReticleRunner.verify', () => {
  it('replays the named flows and assembles a PARTIAL verdict when one fails', async () => {
    const port = fakePort(
      {
        login: replay('login', ReplayStatus.OK),
        checkout: replay('checkout', ReplayStatus.ERROR, {
          error: { code: 'e', message: 'POST /api/order 500' },
        }),
      },
      [],
    );
    const run = await new ReticleRunner(port).verify({ ...opts, names: ['login', 'checkout'] });

    expect(run.flows.map((f) => f.status)).toEqual([RunFlowStatus.PASS, RunFlowStatus.FAIL]);
    expect(run.flows[1]?.failureReason).toBe('POST /api/order 500');
    expect(run.verdict.status).toBe(VerdictStatus.PARTIAL);
    expect(run.runId).toBe('run-1');
    expect(run.profile).toBe(RunProfile.PROD_PREVIEW);
    expect(run.repair).toBeUndefined(); // prod-preview redacts dev-only fix instructions
    expect(run.durationMs).toBeGreaterThan(0);
  });

  it('surfaces repair packets for failed flows under the dev profile', async () => {
    const port = fakePort(
      {
        checkout: replay('checkout', ReplayStatus.ERROR, { error: { code: 'e', message: 'boom' } }),
      },
      [],
    );
    const run = await new ReticleRunner(port).verify({
      ...opts,
      profile: RunProfile.DEV,
      names: ['checkout'],
    });
    expect(run.repair?.failurePackets).toHaveLength(1);
    expect(run.repair?.failurePackets[0]?.flow).toBe('checkout');
  });

  it('verifies every saved flow when names are omitted', async () => {
    const port = fakePort({ a: replay('a', ReplayStatus.OK), b: replay('b', ReplayStatus.OK) }, [
      'a',
      'b',
    ]);
    const run = await new ReticleRunner(port).verify(opts);

    expect(run.flows).toHaveLength(2);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('an empty suite produces a PASS with no flows', async () => {
    const run = await new ReticleRunner(fakePort({}, [])).verify(opts);
    expect(run.flows).toHaveLength(0);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('a gated risk surface fails the verdict even when every flow passes', async () => {
    const port = fakePort({ checkout: replay('checkout', ReplayStatus.OK) }, []);
    const run = await new ReticleRunner(port).verify({
      ...opts,
      names: ['checkout'],
      changedFiles: [{ path: 'src/checkout/PayButton.tsx', changeKind: RunChangeKind.MODIFIED }],
      policy: { requiresConfirmation: [RiskSurface.PAYMENT] },
    });
    expect(run.flows[0]?.status).toBe(RunFlowStatus.PASS);
    expect(run.risks.some((r) => r.surface === RiskSurface.PAYMENT && r.gated)).toBe(true);
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.verdict.blockingRisks).toBe(1);
    expect(run.changedFiles[0]?.risk).toContain(RiskSurface.PAYMENT);
  });
});

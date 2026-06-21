import { describe, expect, it } from 'vitest';
import {
  ReplayStatus,
  RunAgentKind,
  RunConfidence,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type FlowReplayResult,
  asRunId,
} from '@syrin/iris-protocol';
import { IrisRunner, type RunnerPort, type VerifyOptions } from './iris-runner.js';

/**
 * The anti-fabrication guarantee — "Iris cannot report green for something it did not actually verify."
 *
 * This is the property a vision/LLM-narrated QA harness lacks: a verdict that is MECHANICAL, derived
 * only from observed replay outcomes, so a broken or unreachable app can never read as PASS. These
 * tests are the deterministic, in-CI core of that guarantee; the runnable live demo (connected vs
 * severed backend) lives at bench/harness/false-green.mjs.
 */

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

function port(replays: Record<string, FlowReplayResult>, names: string[]): RunnerPort {
  const map = new Map(Object.entries(replays));
  let t = 0;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(names),
    replayFlow: (name) => {
      const r = map.get(name);
      return r === undefined
        ? Promise.reject(new Error(`unreachable: ${name}`))
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
  profile: RunProfile.DEV,
};

describe('false-green guarantee', () => {
  it('a healthy flow is the ONLY thing that yields PASS', async () => {
    const run = await new IrisRunner(
      port({ checkout: replay('checkout', ReplayStatus.OK) }, []),
    ).verify({
      ...opts,
      names: ['checkout'],
    });
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('a severed backend (action could not complete) yields FAIL with evidence, never PASS', async () => {
    const run = await new IrisRunner(
      port(
        {
          checkout: replay('checkout', ReplayStatus.ERROR, {
            error: { code: 'net', message: 'POST /api/order 500' },
          }),
        },
        [],
      ),
    ).verify({ ...opts, names: ['checkout'] });

    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.verdict.status).not.toBe(VerdictStatus.PASS);
    // The verdict is backed by a concrete reason + a repair packet — not a bare narrated green.
    expect(run.verdict.reasons.join(' ')).toContain('POST /api/order 500');
    expect(run.repair?.failurePackets[0]?.actual).toContain('POST /api/order 500');
  });

  it('a drifted consequence (the success oracle did not fire) yields FAIL, never PASS', async () => {
    const run = await new IrisRunner(
      port(
        {
          checkout: replay('checkout', ReplayStatus.DRIFT, {
            decision: {
              verdict: 'drift',
              summary: 'consequence missing',
              whatChanged: 'order:saved never fired',
              nextAction: 'check the handler',
            },
          }),
        },
        [],
      ),
    ).verify({ ...opts, names: ['checkout'] });
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
  });

  it('NO combination of broken replays can produce a PASS verdict', async () => {
    const brokenStatuses = [ReplayStatus.ERROR, ReplayStatus.DRIFT];
    for (const s of brokenStatuses) {
      const run = await new IrisRunner(port({ f: replay('f', s) }, [])).verify({
        ...opts,
        names: ['f'],
      });
      expect(run.verdict.status).not.toBe(VerdictStatus.PASS);
    }
  });

  it('"nothing verified" is NOT a confident pass — empty run is PASS only at LOW confidence', async () => {
    // The honest boundary: with zero flows there is nothing to fail, but the verdict must signal that
    // nothing was actually checked. A deploy gate keys on confidence !== low (or flows.length > 0).
    const run = await new IrisRunner(port({}, [])).verify(opts);
    expect(run.flows).toHaveLength(0);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
    expect(run.verdict.confidence).toBe(RunConfidence.LOW);
  });

  it('a mix of one healthy and one severed flow is PARTIAL (not a blanket PASS)', async () => {
    const run = await new IrisRunner(
      port(
        {
          login: replay('login', ReplayStatus.OK),
          checkout: replay('checkout', ReplayStatus.ERROR, {
            error: { code: 'net', message: '500' },
          }),
        },
        [],
      ),
    ).verify({ ...opts, names: ['login', 'checkout'] });
    expect(run.verdict.status).toBe(VerdictStatus.PARTIAL);
  });
});

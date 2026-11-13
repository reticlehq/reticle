import { describe, expect, it } from 'vitest';
import {
  asRunId,
  ReplayStatus,
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type FlowReplayResult,
} from '@reticlehq/core';
import {
  NO_SESSION_AFTER_NAVIGATION,
  ReticleRunner,
  type RunnerPort,
  type VerifyOptions,
} from './reticle-runner.js';

/*
 * #2060: a suite of saved flows, where one flow went to a page that did not load the SDK. The
 * session dropped and did not come back. The flow after it was then replayed with no session and
 * got the generic "check your port" reason, so its verdict was lost. And the reason of the flow that
 * lost the session did not say where the session was lost.
 */

const DEAD_URL = 'http://localhost:5173/stats?id=missing';

const replay = (
  name: string,
  status: ReplayStatus,
  extra?: Partial<FlowReplayResult>,
): FlowReplayResult => ({ name, status, steps: [], ...extra });

const opts: Omit<VerifyOptions, 'names'> = {
  project: { name: 'demo', framework: RunFramework.OTHER },
  agent: { id: 'pipeline', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  profile: RunProfile.PROD_PREVIEW,
};

interface FakeApp {
  port: RunnerPort;
  replayed: string[];
  reopened: number;
}

/**
 * Three flows. `dead` goes to DEAD_URL, and the session is gone after it. `reopenWorks` says if
 * opening the start URL again brings a session back.
 */
function fakeApp(reopenWorks: boolean, dead: FlowReplayResult): FakeApp {
  const replays = new Map<string, FlowReplayResult>([
    ['first', replay('first', ReplayStatus.OK)],
    ['dead', dead],
    ['last', replay('last', ReplayStatus.OK)],
  ]);
  let t = 0;
  let connected = true;
  const app: FakeApp = {
    replayed: [],
    reopened: 0,
    port: {
      listFlows: () => Promise.resolve(['first', 'dead', 'last']),
      replayFlow: (name) => {
        app.replayed.push(name);
        if (!connected) {
          return Promise.reject(new Error('no browser session connected'));
        }
        if ('dead' === name) {
          connected = false;
        }
        const found = replays.get(name);
        if (found === undefined) {
          return Promise.reject(new Error(`no fake replay for ${name}`));
        }
        return Promise.resolve(found);
      },
      sessionLost: () => Promise.resolve(connected ? undefined : { lastUrl: DEAD_URL }),
      reopen: () => {
        app.reopened += 1;
        connected = reopenWorks;
        return Promise.resolve(reopenWorks);
      },
      now: () => (t += 1),
      newRunId: () => asRunId('run-1'),
    },
  };
  return app;
}

const replaced = replay('dead', ReplayStatus.UNVERIFIABLE, {
  unverifiable: {
    reason: "the page's connection to Reticle was replaced while step 1 was running",
  },
});

describe('a flow that loses its session (#2060)', () => {
  it('names the URL where the session was lost, and is not proved', async () => {
    const app = fakeApp(true, replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    const dead = run.flows[1];
    expect(dead?.status).toBe(RunFlowStatus.SKIPPED);
    expect(dead?.failureReason).toContain(NO_SESSION_AFTER_NAVIGATION);
    expect(dead?.failureReason).toContain(DEAD_URL);
    expect(run.verdict.status).not.toBe(VerdictStatus.PASS);
  });

  it('opens the app again, so the next flow gets its own verdict', async () => {
    const app = fakeApp(true, replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    expect(app.replayed).toEqual(['first', 'dead', 'last']);
    expect(run.flows.map((f) => f.status)).toEqual([
      RunFlowStatus.PASS,
      RunFlowStatus.SKIPPED,
      RunFlowStatus.PASS,
    ]);
  });

  it('when the app does not come back, reports each later flow with what the run saw', async () => {
    const app = fakeApp(false, replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    // `last` is not replayed into a page with no session: that only waits, then blames the port.
    expect(app.replayed).toEqual(['first', 'dead']);
    expect(run.flows.map((f) => f.name)).toEqual(['first', 'dead', 'last']);
    expect(run.flows[0]?.status).toBe(RunFlowStatus.PASS);
    const last = run.flows[2];
    expect(last?.status).toBe(RunFlowStatus.SKIPPED);
    expect(last?.failureReason).toContain(NO_SESSION_AFTER_NAVIGATION);
    expect(last?.failureReason).toContain(DEAD_URL);
    expect(last?.failureReason).toContain('"dead"');
    expect(last?.failureReason).not.toContain('port');
  });

  it('keeps a real failure as a failure', async () => {
    const app = fakeApp(true, replay('dead', ReplayStatus.DRIFT));
    const run = await new ReticleRunner(app.port).verify(opts);
    expect(run.flows[1]?.status).toBe(RunFlowStatus.FAIL);
  });

  it('does not open the app again after the last flow', async () => {
    const app = fakeApp(true, replaced);
    await new ReticleRunner(app.port).verify({ ...opts, names: ['first', 'dead'] });
    expect(app.reopened).toBe(0);
  });
});

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
 * What opening the start URL again does. `back`: a session is connected when reopen returns.
 * `late`: the page loads, but its session connects only while the next flow's replay waits for its
 * start page, as with a dev server that compiles for a long time. `never`: no session comes back.
 */
type Reopen = 'back' | 'late' | 'never';

/** Four flows. `dead` goes to DEAD_URL, and the session is gone after it. */
function fakeApp(reopen: Reopen, dead: FlowReplayResult): FakeApp {
  const replays = new Map<string, FlowReplayResult>([
    ['first', replay('first', ReplayStatus.OK)],
    ['dead', dead],
    ['next', replay('next', ReplayStatus.OK)],
    ['last', replay('last', ReplayStatus.OK)],
  ]);
  let t = 0;
  let connected = true;
  let connectsLate = false;
  const app: FakeApp = {
    replayed: [],
    reopened: 0,
    port: {
      listFlows: () => Promise.resolve(['first', 'dead', 'next', 'last']),
      replayFlow: (name) => {
        app.replayed.push(name);
        // The replay's own start-page wait: a late session connects during it.
        connected ||= connectsLate;
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
        connected = 'back' === reopen;
        // A late session is not there yet when reopen returns.
        connectsLate = 'late' === reopen;
        return Promise.resolve();
      },
      now: () => (t += 1),
      newRunId: () => asRunId('run-1'),
    },
  };
  return app;
}

const REPLACED_REASON = "the page's connection to Reticle was replaced while step 1 was running";

const replaced = replay('dead', ReplayStatus.UNVERIFIABLE, {
  unverifiable: { reason: REPLACED_REASON },
});

describe('a flow that loses its session (#2060)', () => {
  it('names the URL where the session was lost, and is not proved', async () => {
    const app = fakeApp('back', replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    const dead = run.flows[1];
    expect(dead?.status).toBe(RunFlowStatus.SKIPPED);
    expect(dead?.failureReason).toContain(NO_SESSION_AFTER_NAVIGATION);
    expect(dead?.failureReason).toContain(DEAD_URL);
    expect(run.verdict.status).not.toBe(VerdictStatus.PASS);
  });

  // Rule 11: the session-loss reason is added. The reason the replay gave is not dropped.
  it('keeps the reason the replay gave, after the session-loss reason', async () => {
    const app = fakeApp('back', replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    const reason = run.flows[1]?.failureReason ?? '';
    expect(reason.startsWith(NO_SESSION_AFTER_NAVIGATION)).toBe(true);
    expect(reason).toContain(REPLACED_REASON);
  });

  it('opens the app again, so the next flow gets its own verdict', async () => {
    const app = fakeApp('back', replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    expect(app.replayed).toEqual(['first', 'dead', 'next', 'last']);
    expect(run.flows.map((f) => f.status)).toEqual([
      RunFlowStatus.PASS,
      RunFlowStatus.SKIPPED,
      RunFlowStatus.PASS,
      RunFlowStatus.PASS,
    ]);
  });

  // #2155: a dev server can compile the start page for longer than a fixed wait. The next flow's
  // replay waits for its start page, so that flow gets one try before the later flows are given up.
  it('lets the next flow try once when the session comes back late', async () => {
    const app = fakeApp('late', replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    expect(app.replayed).toEqual(['first', 'dead', 'next', 'last']);
    expect(run.flows.map((f) => f.status)).toEqual([
      RunFlowStatus.PASS,
      RunFlowStatus.SKIPPED,
      RunFlowStatus.PASS,
      RunFlowStatus.PASS,
    ]);
  });

  it('when the app does not come back, reports each later flow with what the run saw', async () => {
    const app = fakeApp('never', replaced);
    const run = await new ReticleRunner(app.port).verify(opts);
    // `next` gets one try. `last` is not replayed into a page with no session: that only waits.
    expect(app.replayed).toEqual(['first', 'dead', 'next']);
    expect(run.flows.map((f) => f.name)).toEqual(['first', 'dead', 'next', 'last']);
    expect(run.flows[0]?.status).toBe(RunFlowStatus.PASS);
    for (const later of run.flows.slice(2)) {
      expect(later.status).toBe(RunFlowStatus.SKIPPED);
      expect(later.failureReason).toContain(NO_SESSION_AFTER_NAVIGATION);
      expect(later.failureReason).toContain(DEAD_URL);
      expect(later.failureReason).toContain('"dead"');
    }
    expect(run.flows[3]?.failureReason).not.toContain('port');
    // The flow that tried keeps the reason its replay gave.
    expect(run.flows[2]?.failureReason).toContain('no browser session connected');
  });

  it('keeps a real failure as a failure', async () => {
    const app = fakeApp('back', replay('dead', ReplayStatus.DRIFT));
    const run = await new ReticleRunner(app.port).verify(opts);
    expect(run.flows[1]?.status).toBe(RunFlowStatus.FAIL);
  });

  it('does not open the app again after the last flow', async () => {
    const app = fakeApp('back', replaced);
    await new ReticleRunner(app.port).verify({ ...opts, names: ['first', 'dead'] });
    expect(app.reopened).toBe(0);
  });
});

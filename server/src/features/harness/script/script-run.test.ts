import { describe, expect, it } from 'vitest';
import { ReplayStatus, ReticleTool, ScriptStatus, Verified } from '@reticlehq/core';
import { DriveScriptSchema, type DriveScript } from '@reticlehq/core/artifacts';
import { runScript, type ScriptPorts } from './script-run.js';
import { StopReason, type HarnessResult, type HarnessToolset } from '../harness.js';

interface Call {
  lane: string | undefined;
  name: string;
  args: Record<string, unknown>;
}

/** Ports over a fake app: `failing` flows replay red, `absent` predicates do not hold. */
function fakePorts(
  options: {
    failing?: string[];
    absent?: string[];
    parallel?: number;
    checks?: string;
    goalMet?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let live = 0;
  let peak = 0;
  let released = 0;
  let drives = 0;
  let stop = false;
  const ports: ScriptPorts = {
    parallel: options.parallel ?? 4,
    stopped: () => stop,
    async lease(laneId) {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      return {
        sessionId: laneId,
        release: () => {
          live -= 1;
          released += 1;
          return Promise.resolve();
        },
      };
    },
    toolset(sessionId): HarnessToolset {
      return {
        tools: [],
        async invoke(name, args) {
          calls.push({ lane: sessionId, name, args });
          await new Promise((r) => setTimeout(r, 2));
          if (ReticleTool.FLOW_REPLAY === name) {
            const failed = true === options.failing?.includes(String(args['flowName']));
            return { status: failed ? ReplayStatus.DRIFT : ReplayStatus.OK };
          }
          if (ReticleTool.ASSERT === name) {
            const value = String(
              (args['predicate'] as { query?: { testid?: string } }).query?.testid,
            );
            return { pass: !(options.absent ?? []).includes(value) };
          }
          return { verified: Verified.YES };
        },
      };
    },
    drive(): Promise<HarnessResult> {
      drives += 1;
      return Promise.resolve({
        stopReason: StopReason.FINISHED,
        summary: '',
        steps: 1,
        toolCalls: [
          {
            id: 'c',
            name: ReticleTool.ACT_AND_WAIT,
            args: { ref: 'e1', action: 'click', until: { kind: 'signal', name: 'done' } },
            result: { verified: options.checks ?? Verified.YES },
            isError: false,
          },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        proved: true,
        ...(options.goalMet === undefined ? {} : { goalMet: options.goalMet }),
      });
    },
  };
  return {
    ports,
    calls,
    stats: () => ({ peak, released, drives }),
    stopNow: () => {
      stop = true;
    },
  };
}

const script = (raw: unknown): DriveScript => DriveScriptSchema.parse(raw);
const replay = (flow: string): { kind: 'replay'; flow: string } => ({ kind: 'replay', flow });

const twoLanes = script({
  version: 1,
  source: 'local',
  journeys: [
    { id: 'signin', title: 'Sign in', steps: [replay('signin')] },
    { id: 'refund', title: 'Refund', dependsOn: ['signin'], steps: [replay('refund')] },
    { id: 'settings', title: 'Settings', dependsOn: ['signin'], steps: [replay('settings')] },
    { id: 'audit', title: 'Audit', dependsOn: ['refund'], steps: [replay('audit')] },
  ],
  lanes: [
    { id: 'A', journeys: ['signin', 'refund'] },
    { id: 'B', journeys: ['signin', 'settings', 'audit'] },
  ],
});

describe('running a drive script', () => {
  it('runs lanes at the same time, each in its own context, and releases every lease', async () => {
    const fake = fakePorts();
    const run = await runScript(twoLanes, fake.ports);
    expect(fake.stats().peak).toBe(2);
    expect(fake.stats().released).toBe(2);
    expect(run.view.lanes.flatMap((l) => l.journeys.map((j) => j.status))).toEqual(
      Array(5).fill(ScriptStatus.PASSED),
    );
    // An exact plan never pays a model.
    expect(fake.stats().drives).toBe(0);
    expect(run.toolCalls).toHaveLength(5);
  });

  it('a failure blocks the rest of its lane and every journey waiting on it from another lane', async () => {
    const fake = fakePorts({ failing: ['refund'] });
    const run = await runScript(twoLanes, fake.ports);
    const status = Object.fromEntries(
      run.view.lanes.flatMap((l) => l.journeys.map((j) => [`${l.id}/${j.id}`, j.status])),
    );
    expect(status).toEqual({
      'A/signin': ScriptStatus.PASSED,
      'A/refund': ScriptStatus.FAILED,
      'B/signin': ScriptStatus.PASSED,
      'B/settings': ScriptStatus.PASSED,
      'B/audit': ScriptStatus.BLOCKED,
    });
    expect(fake.calls.some((c) => 'audit' === c.args['flowName'])).toBe(false);
  });

  it('re-enters the checkpoint before every branch case after the first, and skips a case whose condition fails', async () => {
    const fake = fakePorts({ absent: ['otp-input'] });
    const branching = script({
      version: 1,
      source: 'local',
      journeys: [
        {
          id: 'refund',
          title: 'Refund',
          steps: [
            { kind: 'replay', flow: 'refund', to: 3 },
            { kind: 'checkpoint', id: 'dialog', reenter: { flow: 'refund', to: 3 } },
            {
              kind: 'branch',
              at: 'dialog',
              cases: [
                { label: 'full', steps: [{ kind: 'replay', flow: 'refund', at: 3 }] },
                { label: 'partial', steps: [{ kind: 'act', goal: 'refund part' }] },
                {
                  label: '2FA',
                  when: { kind: 'element', testid: 'otp-input' },
                  steps: [{ kind: 'act', goal: 'enter the code' }],
                },
              ],
            },
          ],
        },
      ],
      lanes: [{ id: 'A', journeys: ['refund'] }],
    });
    const run = await runScript(branching, fake.ports);
    expect(fake.calls.map((c) => [c.name, c.args['to'] ?? c.args['at'] ?? ''])).toEqual([
      [ReticleTool.FLOW_REPLAY, 3],
      [ReticleTool.FLOW_REPLAY, 3],
      [ReticleTool.FLOW_REPLAY, 3],
      [ReticleTool.FLOW_REPLAY, 3],
      [ReticleTool.ASSERT, ''],
    ]);
    // `partial` reached the model; `2FA` did not, because its condition did not hold.
    expect(fake.stats().drives).toBe(1);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
  });

  it('switching autonomous driving off stops every lane', async () => {
    const fake = fakePorts({ parallel: 1 });
    let seen = 0;
    const run = await runScript(twoLanes, fake.ports, () => {
      seen += 1;
      if (3 === seen) fake.stopNow();
    });
    expect(run.stopped).toBe(true);
    expect(fake.stats().released).toBe(1);
    expect(run.view.lanes[1]?.journeys.every((j) => ScriptStatus.BLOCKED === j.status)).toBe(true);
  });
});

describe('a lane that breaks', () => {
  it('blocks what it had not finished and says why', async () => {
    const fake = fakePorts();
    const ports: ScriptPorts = {
      ...fake.ports,
      lease: (laneId) =>
        'B' === laneId
          ? Promise.reject(new Error('no browser could start'))
          : fake.ports.lease(laneId),
    };
    const run = await runScript(twoLanes, ports);
    expect(run.view.lanes[1]?.journeys.map((j) => j.status)).toEqual(
      Array(3).fill(ScriptStatus.BLOCKED),
    );
    expect(run.lines.join('\n')).toContain('blocked (no browser could start)');
    expect(run.view.lanes[0]?.journeys.every((j) => ScriptStatus.PASSED === j.status)).toBe(true);
  });
});

/** From the recorded runs: a persona journey whose two checks both failed was marked passed. */
describe('an open journey', () => {
  it('fails when its checks failed, though a check ran', async () => {
    const fake = fakePorts({ checks: Verified.NO });
    const run = await runScript(
      script({
        version: 1,
        source: 'platform',
        journeys: [{ id: 'refund', title: 'Refund', steps: [{ kind: 'act', goal: 'refund it' }] }],
        lanes: [{ id: 'A', journeys: ['refund'] }],
      }),
      fake.ports,
    );
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
  });
});

/** From a live drive: "open each section" passed on two presses of Sign in, its checks holding. */
describe('an open journey whose goal was not reached', () => {
  it('fails, and says the goal is what was missing', async () => {
    const fake = fakePorts({ goalMet: false });
    const run = await runScript(
      script({
        version: 1,
        source: 'platform',
        journeys: [
          {
            id: 'nav',
            title: 'Open each section',
            steps: [{ kind: 'act', goal: 'open each section' }],
          },
        ],
        lanes: [{ id: 'A', journeys: ['nav'] }],
      }),
      fake.ports,
    );
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
    expect(run.lines[0]).toContain('the goal was not reached');
  });
});

/** Lanes run side by side: one lane's missed goal must never be told as another journey's. */
describe('a journey failing beside a lane that missed its goal', () => {
  it('fails on its own reason, not the other lane goal', async () => {
    const fake = fakePorts({ failing: ['broken'] });
    const ports: ScriptPorts = {
      ...fake.ports,
      async drive(toolset, goal, maxSteps) {
        const drive = await fake.ports.drive(toolset, goal, maxSteps);
        // A's drive lands while B is still driving, as two real lanes do.
        await new Promise((r) => setTimeout(r, 'reach b' === goal ? 60 : 20));
        return { ...drive, goalMet: 'reach b' === goal };
      },
    };
    const run = await runScript(
      script({
        version: 1,
        source: 'platform',
        journeys: [
          { id: 'a', title: 'Lane A', steps: [{ kind: 'act', goal: 'reach a' }] },
          {
            id: 'b',
            title: 'Lane B',
            steps: [{ kind: 'act', goal: 'reach b' }, replay('broken')],
          },
        ],
        lanes: [
          { id: 'A', journeys: ['a'] },
          { id: 'B', journeys: ['b'] },
        ],
      }),
      ports,
    );
    const laneB = run.lines.find((line) => line.includes('Lane B')) ?? '';
    expect(laneB).toContain('Lane B');
    expect(laneB).not.toContain('the goal was not reached');
    expect(run.lines.find((line) => line.includes('Lane A'))).toContain('the goal was not reached');
  });
});

/**
 * Found driving the platform chat: "Open the page, see the button reading "count: 0", click it once,
 * and confirm the button now reads "count: 1"" was clicked with no `until`, so the journey held no
 * check and failed on a counter that worked. The end state it quotes is what judges it.
 */
describe('an open goal that quotes where it ends', () => {
  const COUNTER = 'Click the button reading "count: 0" once and confirm it now reads "count: 1".';
  const counter = script({
    version: 1,
    source: 'platform',
    journeys: [{ id: 'count', title: 'Count', steps: [{ kind: 'act', goal: COUNTER }] }],
    lanes: [{ id: 'A', journeys: ['count'] }],
  });
  const onPage = (page: string): ScriptPorts => ({
    parallel: 1,
    stopped: () => false,
    lease: () => Promise.resolve({ release: () => Promise.resolve() }),
    toolset: (): HarnessToolset => ({
      tools: [],
      invoke(name, args) {
        if (ReticleTool.ASSERT !== name) return Promise.resolve({});
        const contains = String((args['predicate'] as { contains?: unknown }).contains);
        const shown = page.includes(contains);
        return Promise.resolve({ pass: shown, verified: shown ? Verified.YES : Verified.NO });
      },
    }),
    // The model clicked and declared nothing: a step, not a check.
    drive: () =>
      Promise.resolve({
        stopReason: StopReason.FINISHED,
        summary: '',
        steps: 1,
        toolCalls: [
          {
            id: 'c',
            name: ReticleTool.ACT_AND_WAIT,
            args: { ref: 'e6', action: 'click' },
            result: { verified: 'no-fault' },
            isError: false,
          },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        proved: false,
      }),
  });

  it('passes on the text it ends on, and keeps that assert as the run’s check', async () => {
    const run = await runScript(counter, onPage('button "count: 1"'));
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
    const asserted = run.toolCalls.filter((c) => ReticleTool.ASSERT === c.name);
    expect(asserted.map((c) => (c.result as { verified?: unknown }).verified)).toEqual([
      Verified.YES,
    ]);
  });

  it('fails when the page still shows where it started', async () => {
    const run = await runScript(counter, onPage('button "count: 0"'));
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
  });
});

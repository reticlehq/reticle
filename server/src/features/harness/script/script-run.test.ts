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
    /** Flows with a destructive step: refused unless the replay acknowledges it. */
    guarded?: string[];
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
            if (
              true === options.guarded?.includes(String(args['flowName'])) &&
              true !== args['confirmDangerous']
            )
              throw new Error(
                'potentially destructive action blocked; retry with args.confirmDangerous=true',
              );
            const failed = true === options.failing?.includes(String(args['flowName']));
            // A failing journey's replay ran and did not hold: a drift would be undecided.
            return { status: failed ? ReplayStatus.ERROR : ReplayStatus.OK };
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

/** A drive the platform cut off (credits gone, 402) read as a journey that ran and was judged. */
describe('a journey whose drive the platform cut off', () => {
  it('is blocked, not passed or failed, and says the platform’s reason', async () => {
    const fake = fakePorts();
    const credits = 'Your 10 free credits are used.';
    const ports: ScriptPorts = {
      ...fake.ports,
      drive: async (...args) => ({
        ...(await fake.ports.drive(...args)),
        stopReason: StopReason.BROKEN,
        goalMet: false,
        error: credits,
      }),
    };
    const run = await runScript(
      script({
        version: 1,
        source: 'platform',
        journeys: [
          { id: 'compose', title: 'Compose', steps: [{ kind: 'act', goal: 'compose one' }] },
          { id: 'save', title: 'Save', steps: [{ kind: 'act', goal: 'save it' }] },
        ],
        lanes: [{ id: 'A', journeys: ['compose', 'save'] }],
      }),
      ports,
    );
    expect(run.view.lanes[0]?.journeys.map((j) => j.status)).toEqual([
      ScriptStatus.BLOCKED,
      ScriptStatus.BLOCKED,
    ]);
    expect(run.lines[0]).toContain(`blocked (${credits})`);
    expect(run.drives.some((d) => StopReason.BROKEN === d.stopReason)).toBe(true);
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
        if (ReticleTool.SNAPSHOT === name) return Promise.resolve({ tree: page });
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
    // The page reads "count: 1" only once the drive has clicked.
    let clicked = false;
    const page = onPage('');
    const ports: ScriptPorts = {
      ...page,
      toolset: () => ({
        tools: [],
        invoke: (name, args) =>
          onPage(clicked ? 'button "count: 1"' : 'button "count: 0"')
            .toolset(undefined, undefined)
            .invoke(name, args),
      }),
      drive: (...args) => {
        clicked = true;
        return page.drive(...args);
      },
    };
    const run = await runScript(counter, ports);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
    const asserted = run.toolCalls.filter((c) => ReticleTool.ASSERT === c.name);
    expect(asserted.map((c) => (c.result as { verified?: unknown }).verified)).toEqual([
      Verified.YES,
    ]);
  });

  // The saved plan is named after the journey; listed back on a page, it is not the journey's end.
  it('fails when the end shows only inside the journey the Harness wrote', async () => {
    const run = await runScript(counter, {
      ...onPage(`- link "${COUNTER}" (ref=e1)`),
      own: [COUNTER],
    });
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
  });

  it('fails when the page still shows where it started', async () => {
    const run = await runScript(counter, onPage('button "count: 0"'));
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
    // The journey missed; the app was not caught failing, so no failed check is kept.
    expect(run.toolCalls.filter((c) => ReticleTool.ASSERT === c.name)).toEqual([]);
  });
});

/*
 * From a persona drive: the Harness joined the workspace, opened Runs and finished three actions
 * into twenty steps, one click short of the "Team" step its own plan named, so "acme-checkout" was
 * never on the page it was graded on.
 */
describe('a drive that finishes short of the end its goal names', () => {
  const GOAL = 'Open Runs, select Team, and end when the page shows "acme-checkout".';
  const journey = script({
    version: 1,
    source: 'platform',
    journeys: [{ id: 'team', title: 'Team', steps: [{ kind: 'act', goal: GOAL }] }],
    lanes: [{ id: 'A', journeys: ['team'] }],
  });
  const ports = (reachesOn: number) => {
    let page = 'button "Team"';
    const asked: [string, number][] = [];
    const port: ScriptPorts = {
      parallel: 1,
      stopped: () => false,
      lease: () => Promise.resolve({ release: () => Promise.resolve() }),
      toolset: (): HarnessToolset => ({
        tools: [],
        invoke(name, args) {
          if (ReticleTool.SNAPSHOT === name) return Promise.resolve({ tree: page });
          if (ReticleTool.ASSERT !== name) return Promise.resolve({});
          const contains = String((args['predicate'] as { contains?: unknown }).contains);
          const shown = page.includes(contains);
          return Promise.resolve({ pass: shown, verified: shown ? Verified.YES : Verified.NO });
        },
      }),
      drive: (_tools, goal, maxSteps) => {
        asked.push([goal, maxSteps]);
        if (reachesOn === asked.length) page = 'cell "acme-checkout"';
        return Promise.resolve({
          stopReason: StopReason.FINISHED,
          summary: '',
          steps: 3,
          toolCalls: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          proved: false,
          goalMet: reachesOn === asked.length,
        });
      },
    };
    return { port, asked };
  };

  it('is sent on once from where it stands, with the turns it has left, and passes there', async () => {
    const p = ports(2);
    const run = await runScript(journey, p.port);
    expect(p.asked).toHaveLength(2);
    expect(p.asked[1]?.[0]).toContain('does not show "acme-checkout" yet');
    expect(p.asked[1]?.[1]).toBe(37);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
  });

  it('fails as a missed goal, with no failed check, when it still does not get there', async () => {
    const p = ports(99);
    const run = await runScript(journey, p.port);
    expect(p.asked).toHaveLength(2);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
    expect(run.toolCalls.filter((c) => ReticleTool.ASSERT === c.name)).toEqual([]);
  });
});

describe('a journey that runs on how another ended', () => {
  const branching = script({
    version: 1,
    source: 'platform',
    journeys: [
      { id: 'signin', title: 'Sign in', steps: [replay('signin')] },
      {
        id: 'error-shown',
        title: 'The error says why',
        when: { journey: 'signin', is: 'failed' },
        steps: [replay('error-shown')],
      },
      {
        id: 'dashboard',
        title: 'Dashboard',
        when: { journey: 'signin', is: 'passed' },
        steps: [replay('dashboard')],
      },
      { id: 'audit', title: 'Audit', steps: [replay('audit')] },
    ],
    lanes: [
      { id: 'A', journeys: ['signin', 'error-shown', 'dashboard'] },
      { id: 'B', journeys: ['audit'] },
    ],
  });
  const statuses = (run: Awaited<ReturnType<typeof runScript>>): Record<string, string> =>
    Object.fromEntries(run.view.lanes.flatMap((l) => l.journeys.map((j) => [j.id, j.status])));

  it('takes the passed road when it passed, and leaves the other not taken', async () => {
    const fake = fakePorts();
    expect(statuses(await runScript(branching, fake.ports))).toEqual({
      signin: ScriptStatus.PASSED,
      'error-shown': ScriptStatus.NOT_TAKEN,
      dashboard: ScriptStatus.PASSED,
      audit: ScriptStatus.PASSED,
    });
    expect(fake.calls.some((c) => 'error-shown' === c.args['flowName'])).toBe(false);
  });

  it('takes the failed road when it failed, though the lane is otherwise blocked by it', async () => {
    const fake = fakePorts({ failing: ['signin'] });
    expect(statuses(await runScript(branching, fake.ports))).toEqual({
      signin: ScriptStatus.FAILED,
      'error-shown': ScriptStatus.PASSED,
      dashboard: ScriptStatus.NOT_TAKEN,
      audit: ScriptStatus.PASSED,
    });
  });
});

/*
 * A "Place order" flow run from the dashboard was badged "failed" on the plan page: the guard had
 * skipped it. And a person's Run plan could never acknowledge it.
 */
describe('a replay the destructive-action guard stops', () => {
  const order = script({
    version: 1,
    source: 'local',
    journeys: [{ id: 'order', title: 'Place order', steps: [replay('place-order')] }],
    lanes: [{ id: 'A', journeys: ['order'] }],
  });

  it('is not taken, with the reason, never failed', async () => {
    const fake = fakePorts({ guarded: ['place-order'] });
    const run = await runScript(order, fake.ports);
    const card = run.view.lanes[0]?.journeys[0];
    expect(card?.status).toBe(ScriptStatus.NOT_TAKEN);
    expect(card?.steps[0]?.status).toBe(ScriptStatus.NOT_TAKEN);
    expect(card?.why).toContain('destructive');
    expect(run.lines[0]).toContain('not-taken');
  });

  it('runs when the person who started it acknowledged it', async () => {
    const fake = fakePorts({ guarded: ['place-order'] });
    const run = await runScript(order, { ...fake.ports, confirmDangerous: true });
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
  });
});

/*
 * Persona 25: a plan's second journey ("Reload the checkout and place the order … ending when the
 * page shows "Order confirmed"") started on the page the first journey left, which already showed
 * "Order confirmed". It never reloaded, drove nothing, and failed with no goals. A journey that does
 * not build on the one before it starts from where the lane started, and an end already on screen
 * before it acted is never credited to it.
 */
describe('a journey that does not build on the one before it in its lane', () => {
  const END = 'Order confirmed';
  const checkout = script({
    version: 1,
    source: 'platform',
    journeys: [
      {
        id: 'coupon',
        title: 'With a coupon',
        steps: [{ kind: 'act', goal: `Apply the coupon and place the order, ending on "${END}".` }],
      },
      {
        id: 'plain',
        title: 'Order without a coupon',
        when: { journey: 'coupon', is: 'passed' },
        steps: [{ kind: 'act', goal: `Place the order without the coupon, ending on "${END}".` }],
      },
    ],
    lanes: [{ id: 'A', journeys: ['coupon', 'plain'] }],
  });
  /** A checkout that confirms an order once driven; `sticky` keeps the confirmation over a reload. */
  const app = (sticky: boolean) => {
    let confirmed = false;
    let drives = 0;
    const navigated: unknown[] = [];
    const tree = (): string =>
      confirmed ? `- status "${END}"` : '- button "Place order" (ref=e1)';
    const port: ScriptPorts = {
      parallel: 1,
      stopped: () => false,
      lease: () => Promise.resolve({ release: () => Promise.resolve() }),
      toolset: (): HarnessToolset => ({
        tools: [],
        invoke(name, args) {
          if (ReticleTool.SNAPSHOT === name)
            return Promise.resolve({ tree: tree(), status: { route: '/checkout' } });
          if (ReticleTool.NAVIGATE === name) {
            navigated.push(args['url']);
            confirmed = sticky && confirmed;
            return Promise.resolve({ ok: true });
          }
          if (ReticleTool.ASSERT !== name) return Promise.resolve({});
          const shown = tree().includes(
            String((args['predicate'] as { contains?: unknown }).contains),
          );
          return Promise.resolve({ pass: shown, verified: shown ? Verified.YES : Verified.NO });
        },
      }),
      drive: () => {
        drives += 1;
        confirmed = true;
        return Promise.resolve({
          stopReason: StopReason.FINISHED,
          summary: '',
          steps: 2,
          toolCalls: [
            {
              id: 'c',
              name: ReticleTool.ACT_AND_WAIT,
              args: { ref: 'e1', action: 'click' },
              result: { verified: 'no-fault' },
              isError: false,
            },
          ],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          proved: false,
          goalMet: true,
        });
      },
    };
    return { port, navigated, drives: () => drives };
  };

  it('starts from where the lane started, and passes on the end it reached itself', async () => {
    const a = app(false);
    const run = await runScript(checkout, a.port);
    expect(a.navigated).toEqual(['/checkout']);
    expect(a.drives()).toBe(2);
    expect(run.view.lanes[0]?.journeys.map((j) => j.status)).toEqual([
      ScriptStatus.PASSED,
      ScriptStatus.PASSED,
    ]);
  });

  // Persona drive: a read-only journey whose end text is on the page before anything acts could
  // never be proved, and was graded "failed" — a finding against an app that did nothing wrong.
  // Persona drive: goal graded yes, goalMet true, and the journey still "failed" because nothing it
  // drove declared a check. Reached with nothing that could go red is undecided, never failed.
  it('a journey that reached its goal with no check is undecided, not failed', async () => {
    const a = app(false);
    const open = script({
      version: 1,
      source: 'platform',
      journeys: [
        { id: 'read', title: 'Read the page', steps: [{ kind: 'act', goal: 'Open it.' }] },
      ],
      lanes: [{ id: 'A', journeys: ['read'] }],
    });
    const run = await runScript(open, a.port);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.UNDECIDED);
  });

  // A re-drive: started on a dead link, the drive reached the page and its end showed (graded yes),
  // but the driver's own word was "not met" and the journey was "failed" beside a goal that held.
  // The page is the evidence; the driver's word is not.
  it('passes on an end the page shows, whatever the driver said', async () => {
    const a = app(false);
    const doubting: ScriptPorts = {
      ...a.port,
      drive: async (tools, goal, steps) => ({
        ...(await a.port.drive(tools, goal, steps)),
        goalMet: false,
      }),
    };
    const run = await runScript(checkout, doubting);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
  });

  it('is never credited with an end that was on screen before it acted, nor failed for it', async () => {
    const a = app(true);
    const run = await runScript(checkout, a.port);
    expect(run.view.lanes[0]?.journeys[1]?.status).toBe(ScriptStatus.UNDECIDED);
    // Nothing it could do would prove it, so no model turn is spent on it.
    expect(a.drives()).toBe(1);
    expect(run.lines[1]).toContain('already on the page before this journey acted');
  });
});

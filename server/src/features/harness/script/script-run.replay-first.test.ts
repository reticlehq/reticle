/**
 * Replay first: a journey the platform serves as replays of flows that passed last time, with its
 * goal kept as `fallback`. The model drives the goal only when every replay decided nothing; a replay
 * that failed is a regression and is never re-driven.
 */
import { describe, expect, it } from 'vitest';
import { ReplayStatus, ReticleTool, ScriptStatus, Verified } from '@reticlehq/core';
import { DriveScriptSchema, JourneyBy, type DriveScript } from '@reticlehq/core/artifacts';
import { runScript, type ScriptPorts } from './script-run.js';
import { StopReason, type HarnessResult } from '../harness.js';

const GOAL = 'Ana pays for her cart';

function ports(replays: Record<string, string>, refused?: string) {
  const goals: string[] = [];
  const p: ScriptPorts = {
    parallel: 1,
    stopped: () => false,
    lease: () => Promise.resolve({ release: () => Promise.resolve() }),
    toolset: () => ({
      tools: [],
      invoke(name, args) {
        if (ReticleTool.FLOW_REPLAY === name)
          return Promise.resolve({ status: replays[String(args['flowName'])] });
        return Promise.resolve({ verified: Verified.YES, pass: true });
      },
    }),
    drive(_tools, goal): Promise<HarnessResult> {
      goals.push(goal);
      return Promise.resolve({
        stopReason: StopReason.FINISHED,
        summary: '',
        steps: 2,
        toolCalls: [
          {
            id: 'c1',
            name: ReticleTool.ACT_AND_WAIT,
            args: { ref: 'e1', action: 'click', until: { kind: 'signal', name: 'paid' } },
            result: { verified: Verified.YES },
            isError: false,
          },
          {
            id: 'c2',
            name: ReticleTool.FLOW_SAVE,
            args: {},
            result: { name: 'ana-pays' },
            isError: false,
          },
        ],
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
        proved: true,
        creditsSpent: 1,
      });
    },
    ...(refused === undefined ? {} : { fallbackRefused: () => Promise.resolve(refused) }),
  };
  return { ports: p, goals };
}

const served = (flows: string[], fallback = true): DriveScript =>
  DriveScriptSchema.parse({
    version: 1,
    source: 'platform',
    journeys: [
      {
        id: 'j1',
        title: 'Ana: pays',
        steps: flows.map((flow) => ({ kind: 'replay', flow })),
        ...(fallback ? { fallback: { goal: GOAL } } : {}),
      },
    ],
    lanes: [{ id: 'A', journeys: ['j1'] }],
  });

describe('replay first', () => {
  it('a replay that holds passes the journey with no model, and says so', async () => {
    const fake = ports({ pay: ReplayStatus.OK });
    const run = await runScript(served(['pay']), fake.ports);
    expect(fake.goals).toEqual([]);
    expect(run.journeys).toEqual([{ id: 'j1', by: JourneyBy.REPLAY, tokens: 0, flows: ['pay'] }]);
    expect(run.lines[0]).toContain('replayed, no model tokens');
  });

  it('every replay undecided: the model drives the fallback goal, and its cost is counted', async () => {
    const fake = ports({ pay: ReplayStatus.UNVERIFIABLE, cart: ReplayStatus.DRIFT });
    const run = await runScript(served(['cart', 'pay']), fake.ports);
    expect(fake.goals).toEqual([GOAL]);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
    expect(run.journeys).toEqual([
      {
        id: 'j1',
        by: JourneyBy.MODEL,
        tokens: 126,
        credits: 1,
        // `pay` never ran: the journey stopped at the replay that decided nothing.
        flows: ['cart', 'ana-pays'],
      },
    ]);
    expect(run.lines[0]).toContain('driven by the model');
    expect(run.lines[0]).toContain('126 tokens');
  });

  it('a replay that failed is a regression: never re-driven', async () => {
    const fake = ports({ pay: ReplayStatus.ERROR, cart: ReplayStatus.UNVERIFIABLE });
    const run = await runScript(served(['pay', 'cart']), fake.ports);
    expect(fake.goals).toEqual([]);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
    expect(run.journeys[0]?.by).toBe(JourneyBy.REPLAY);
  });

  /*
   * Re-check: a journey saved as a sign-in flow and a mid-session flow. The sign-in held,
   * the second drifted, and the plan read "Failed" on an unchanged app because not EVERY replay was
   * undecided. A drift decided nothing about the app: the goal falls back to the model.
   */
  it('a held replay beside a drifted one decided nothing: the model drives the goal', async () => {
    const fake = ports({ cart: ReplayStatus.OK, pay: ReplayStatus.DRIFT });
    const run = await runScript(served(['cart', 'pay']), fake.ports);
    expect(fake.goals).toEqual([GOAL]);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
  });

  it('a journey from an older platform, with no fallback, is undecided, never failed', async () => {
    const fake = ports({ pay: ReplayStatus.UNVERIFIABLE });
    const run = await runScript(served(['pay'], false), fake.ports);
    expect(fake.goals).toEqual([]);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.UNDECIDED);
  });

  // One journey, one chain: the flow after a held one continues on the page it left (`at: 0`), so a
  // page load never discards the sign-in the flow before it made.
  it("replays a journey's flows as one chain: each after the first continues the page", async () => {
    const calls: Record<string, unknown>[] = [];
    const fake = ports({ cart: ReplayStatus.OK, pay: ReplayStatus.OK });
    const inner = fake.ports.toolset('', undefined);
    fake.ports.toolset = () => ({
      tools: [],
      invoke(name, args) {
        if (ReticleTool.FLOW_REPLAY === name) calls.push(args);
        return inner.invoke(name, args);
      },
    });
    await runScript(served(['cart', 'pay']), fake.ports);
    expect(calls.map((args) => args['at'])).toEqual([undefined, 0]);
  });

  it('a fallback the Harness may not drive is blocked with the reason, and costs nothing', async () => {
    const fake = ports({ pay: ReplayStatus.UNVERIFIABLE }, 'No Harness credits left.');
    const run = await runScript(served(['pay']), fake.ports);
    expect(fake.goals).toEqual([]);
    const card = run.view.lanes[0]?.journeys[0];
    expect(card?.status).toBe(ScriptStatus.BLOCKED);
    expect(run.lines[0]).toContain('No Harness credits left.');
  });
});

/**
 * A plan run on the dashboard ended "failed (\"Saved items\" was already on the page before this
 * journey acted…) · replayed, no model tokens": a model goal the end-already-shown guard stopped
 * before any model turn, labelled as a replay because it spent no tokens. The guard is for model
 * goals; a replay decides itself, and a journey is called replayed only when it replayed.
 */
describe('the end-already-shown guard and replays', () => {
  const END = 'Saved items';
  const showing = (
    onPage: () => boolean,
    replays: Record<string, string>,
    onCall: (name: string) => void = () => undefined,
  ) => {
    const navigated: unknown[] = [];
    const goals: string[] = [];
    const port: ScriptPorts = {
      parallel: 1,
      stopped: () => false,
      lease: () => Promise.resolve({ release: () => Promise.resolve() }),
      toolset: () => ({
        tools: [],
        invoke(name, args) {
          onCall(name);
          if (ReticleTool.FLOW_REPLAY === name)
            return Promise.resolve({ status: replays[String(args['flowName'])] });
          if (ReticleTool.NAVIGATE === name) {
            navigated.push(args['url']);
            return Promise.resolve({ ok: true });
          }
          if (ReticleTool.SNAPSHOT === name)
            return Promise.resolve({
              tree: onPage() ? `- heading "${END}"` : '- button "Sign in" (ref=e1)',
              status: { route: onPage() ? '/saved' : '/login' },
            });
          return Promise.resolve({ pass: onPage(), verified: Verified.YES });
        },
      }),
      drive(_tools, goal): Promise<HarnessResult> {
        goals.push(goal);
        return Promise.resolve({
          stopReason: StopReason.FINISHED,
          summary: '',
          steps: 1,
          toolCalls: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          proved: false,
        });
      },
    };
    return { port, navigated, goals };
  };
  const goalOnly = DriveScriptSchema.parse({
    version: 1,
    source: 'platform',
    journeys: [
      {
        id: 'j1',
        title: 'Lee: saved',
        steps: [{ kind: 'act', goal: `End when the page shows "${END}".` }],
      },
    ],
    lanes: [{ id: 'A', journeys: ['j1'] }],
  });

  it('a model goal the guard stopped is not called replayed', async () => {
    const fake = showing(() => true, {});
    const run = await runScript(goalOnly, fake.port);
    expect(fake.goals).toEqual([]);
    expect(run.lines[0]).toContain('already on the page');
    expect(run.lines[0]).not.toContain('replayed');
    expect(run.journeys[0]?.by).toBeUndefined();
  });

  it('a replay journey is decided by its replay, whatever the page showed before it', async () => {
    const fake = showing(() => true, { saved: ReplayStatus.OK });
    const run = await runScript(served(['saved']), fake.port);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.PASSED);
    expect(run.journeys[0]?.by).toBe(JourneyBy.REPLAY);
  });

  it("a fallback starts where its journey began, not where the journey's own replay left the tab", async () => {
    let page = false;
    // The replay drifted on the way, having reached the end page; the journey began signed out.
    const fake = showing(
      () => page,
      { saved: ReplayStatus.DRIFT },
      (name) => {
        if (ReticleTool.FLOW_REPLAY === name) page = true;
        if (ReticleTool.NAVIGATE === name) page = false;
      },
    );
    await runScript(served(['saved']), fake.port);
    expect(fake.navigated).toEqual(['/login']);
    expect(fake.goals).toEqual([GOAL]);
  });
});

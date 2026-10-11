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

  it('a held replay beside an undecided one is not every replay undecided: no model', async () => {
    const fake = ports({ cart: ReplayStatus.OK, pay: ReplayStatus.UNVERIFIABLE });
    await runScript(served(['cart', 'pay']), fake.ports);
    expect(fake.goals).toEqual([]);
  });

  it('a journey from an older platform, with no fallback, stays as it was', async () => {
    const fake = ports({ pay: ReplayStatus.UNVERIFIABLE });
    const run = await runScript(served(['pay'], false), fake.ports);
    expect(fake.goals).toEqual([]);
    expect(run.view.lanes[0]?.journeys[0]?.status).toBe(ScriptStatus.FAILED);
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

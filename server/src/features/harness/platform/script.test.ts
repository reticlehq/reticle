import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleTool,
  StepEffect,
} from '@reticlehq/core';
import {
  drivesNothing,
  fetchScript,
  journeyResults,
  reportPlanBlocked,
  personasIn,
  proposeScript,
  reportPlanResults,
  WHOLE_APP_REQUEST,
  replayFirst,
} from './script.js';
import { ScriptStatus } from '@reticlehq/core';
import { DriveScriptSchema, JourneyBy } from '@reticlehq/core/artifacts';

const flow = {
  version: FLOW_FILE_VERSION,
  name: 'refund',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'card' },
      action: ActionType.FILL,
      args: { value: '4242 4242 4242 4242' },
    },
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'pay' },
      action: ActionType.CLICK,
      args: {},
      effect: StepEffect.COMMITS,
    },
  ],
};
const ask = {
  about: 'a shop',
  flows: [flow],
  replay: ['refund'],
  goals: [],
  gaps: [],
  rules: ['r'],
};
const answer = (script: unknown) => (_url: string, init: RequestInit) => {
  sent.push('string' === typeof init.body ? init.body : '');
  return Promise.resolve(new Response(JSON.stringify({ script }), { status: 200 }));
};
let sent: string[] = [];

describe('asking the platform for the drive plan', () => {
  it('sends step hashes, never the values a step typed', async () => {
    sent = [];
    await proposeScript({ url: 'https://p', apiKey: 'k' }, ask, answer(undefined));
    expect(sent[0]).not.toContain('4242');
    const body = JSON.parse(sent[0] ?? '{}') as { flows: unknown[] };
    expect(body.flows[0]).toMatchObject({ name: 'refund', commits: [1] });
  });

  /*
   * The platform now refuses a plan request that names nothing ("Nothing to plan") and no longer
   * invents personas. A run with no journey, no saved persona and nothing to replay is a request for
   * the whole app, and says so in words the platform splits into journeys.
   */
  it('asks for the whole app when nothing else is named, and never sends an empty ask', async () => {
    sent = [];
    await proposeScript(
      { url: 'https://p', apiKey: 'k' },
      { ...ask, replay: [], goals: [] },
      answer(undefined),
    );
    expect((JSON.parse(sent[0] ?? '{}') as { goals: string[] }).goals).toEqual([WHOLE_APP_REQUEST]);
    sent = [];
    await proposeScript(
      { url: 'https://p', apiKey: 'k' },
      { ...ask, replay: [], goals: ['Nina signs up'] },
      answer(undefined),
    );
    expect((JSON.parse(sent[0] ?? '{}') as { goals: string[] }).goals).toEqual(['Nina signs up']);
  });

  it('carries what writing the plan cost, which is part of the run', async () => {
    const good = {
      version: 1,
      source: 'platform',
      journeys: [{ id: 'refund', title: 'Refund', steps: [{ kind: 'replay', flow: 'refund' }] }],
      lanes: [{ id: 'A', journeys: ['refund'] }],
    };
    const priced = () =>
      Promise.resolve(
        new Response(JSON.stringify({ script: good, creditsSpent: 0.25 }), { status: 200 }),
      );
    expect(await proposeScript({ url: 'https://p', apiKey: 'k' }, ask, priced)).toMatchObject({
      creditsSpent: 0.25,
    });
  });

  it('runs a plan that passes the checks, and drops one that does not', async () => {
    const good = {
      version: 1,
      source: 'platform',
      journeys: [{ id: 'refund', title: 'Refund', steps: [{ kind: 'replay', flow: 'refund' }] }],
      lanes: [{ id: 'A', journeys: ['refund'] }],
    };
    const platform = { url: 'https://p', apiKey: 'k' };
    const proposed = await proposeScript(platform, ask, answer(good));
    expect(proposed !== undefined && 'script' in proposed ? proposed.script.source : '').toBe(
      'platform',
    );
    const orphaned = { ...good, lanes: [] };
    expect(await proposeScript(platform, ask, answer(orphaned))).toBeUndefined();
  });

  it('a platform that could not plan says why, so the drive can say it went on without one', async () => {
    const refused = await proposeScript({ url: 'https://p', apiKey: 'k' }, ask, () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'The plan could not be made.' } }), {
          status: 502,
        }),
      ),
    );
    expect(refused).toEqual({ refused: 'The plan could not be made.' });
  });
});

/** From two recorded whole-app runs: new people every time, so no flow was ever driven twice. */
describe('the personas a project already drove', () => {
  const flow = (intent?: string) =>
    ({ name: 'f', version: 1, steps: [], ...(intent === undefined ? {} : { intent }) }) as never;

  it('are read back from their flows, once each, and sent with the next plan', async () => {
    const personas = personasIn([
      flow('Support agent: refunds a captured payment'),
      flow('Support agent: a second flow of the same person'),
      flow('Finance reconciler: exports captured payments'),
      flow('no colon here'),
      flow('Ops: settles\n\nThe product rules for this journey: never twice'),
      flow(),
    ]);
    expect(personas).toEqual([
      { name: 'Support agent', journey: 'refunds a captured payment' },
      { name: 'Finance reconciler', journey: 'exports captured payments' },
      { name: 'Ops', journey: 'settles' },
    ]);
    let sent: Record<string, unknown> = {};
    await proposeScript(
      { url: 'https://p', apiKey: 'k' },
      { about: '', flows: [], replay: [], goals: [], gaps: [], rules: [], personas },
      (_url, init) => {
        sent = JSON.parse('string' === typeof init.body ? init.body : '{}') as Record<
          string,
          unknown
        >;
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
    );
    expect(sent['personas']).toEqual(personas);
  });
});

/** The platform's next plan drives what failed first, so it has to be told what failed. */
describe('how a plan went', () => {
  const card = (id: string, status: ScriptStatus) => ({
    id,
    title: id,
    waitsOn: [],
    status,
    steps: [],
  });

  it('reports each journey once, at its worst, though it ran in two lanes', () => {
    const results = journeyResults({
      parallel: 2,
      lanes: [
        {
          id: 'A',
          journeys: [card('signin', ScriptStatus.PASSED), card('refund', ScriptStatus.FAILED)],
        },
        {
          id: 'B',
          journeys: [card('signin', ScriptStatus.FAILED), card('settings', ScriptStatus.BLOCKED)],
        },
      ],
    });
    expect(results).toEqual([
      { id: 'signin', title: 'signin', status: ScriptStatus.FAILED },
      { id: 'refund', title: 'refund', status: ScriptStatus.FAILED },
      { id: 'settings', title: 'settings', status: ScriptStatus.BLOCKED },
    ]);
  });

  it('carries how each journey was answered, and matches journeys by id, never by title', () => {
    const same = (id: string, status: ScriptStatus) => ({
      ...card(id, status),
      title: 'Ana: pays',
    });
    const results = journeyResults(
      {
        parallel: 1,
        lanes: [
          {
            id: 'A',
            journeys: [same('j1', ScriptStatus.PASSED), same('j2', ScriptStatus.FAILED)],
          },
        ],
      },
      [
        { id: 'j1', by: JourneyBy.REPLAY, tokens: 0, flows: ['pay'] },
        { id: 'j2', by: JourneyBy.MODEL, tokens: 900, credits: 2, flows: ['pay', 'ana-pays'] },
      ],
    );
    expect(results).toEqual([
      {
        id: 'j1',
        title: 'Ana: pays',
        status: ScriptStatus.PASSED,
        by: JourneyBy.REPLAY,
        tokens: 0,
        flows: ['pay'],
      },
      {
        id: 'j2',
        title: 'Ana: pays',
        status: ScriptStatus.FAILED,
        by: JourneyBy.MODEL,
        tokens: 900,
        credits: 2,
        flows: ['pay', 'ana-pays'],
      },
    ]);
  });

  it('tells the platform against the plan’s own id', async () => {
    let asked = '';
    let body = '';
    const ok = await reportPlanResults(
      { url: 'https://p', apiKey: 'k' },
      'hp_1',
      [{ id: 'refund', title: 'Refund', status: ScriptStatus.FAILED }],
      ['harness-1'],
      (url, init) => {
        asked = url;
        body = 'string' === typeof init.body ? init.body : '';
        return Promise.resolve(new Response('{"saved":true}', { status: 200 }));
      },
    );
    expect(ok).toBe(true);
    expect(asked).toBe('https://p/v1/harness/scripts/hp_1/results');
    expect(JSON.parse(body)).toEqual({
      results: [{ id: 'refund', title: 'Refund', status: 'failed' }],
      runIds: ['harness-1'],
    });
  });

  it('reads a saved plan as it stands, and refuses one that cannot run', async () => {
    const saved = {
      version: 1,
      source: 'platform',
      journeys: [{ id: 'signin', title: 'Sign in', steps: [{ kind: 'replay', flow: 'signin' }] }],
      lanes: [{ id: 'A', journeys: ['signin'] }],
    };
    let asked = '';
    const answer = (script: unknown) => (url: string) => {
      asked = url;
      return Promise.resolve(new Response(JSON.stringify({ planId: 'hp_1', script })));
    };
    const read = await fetchScript({ url: 'https://p', apiKey: 'k' }, 'hp_1', answer(saved));
    expect(asked).toBe('https://p/v1/harness/scripts/hp_1');
    expect(read?.journeys.map((j) => j.id)).toEqual(['signin']);
    const unplaced = { ...saved, lanes: [] };
    expect(
      await fetchScript({ url: 'https://p', apiKey: 'k' }, 'hp_1', answer(unplaced)),
    ).toBeUndefined();
  });
});

/** A journey is replayed instead of re-driven only when its flows assert something. */
describe('what a flow is sent with', () => {
  it('carries how many of its steps assert a consequence', async () => {
    let body = '';
    await proposeScript(
      { url: 'https://p', apiKey: 'k' },
      {
        about: '',
        flows: [
          {
            name: 'refund',
            version: 1,
            steps: [
              { tool: 'reticle_act', anchor: { kind: 'testid', value: 'a' }, action: 'click' },
              {
                tool: 'reticle_act',
                anchor: { kind: 'testid', value: 'b' },
                action: 'click',
                expect: { kind: 'net', method: 'POST', urlContains: '/refund' },
              },
            ],
          } as never,
        ],
        replay: [],
        goals: [],
        gaps: [],
        rules: [],
      },
      (_url, init) => {
        body = 'string' === typeof init.body ? init.body : '';
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
    );
    expect((JSON.parse(body) as { flows: { checks: number }[] }).flows[0]?.checks).toBe(1);
  });
});

/** A plan the platform refused, or that broke before a journey ran, still reports to its plan. */
describe('a plan that never got to run', () => {
  const saved = {
    version: 1,
    source: 'platform',
    journeys: [
      { id: 'signin', title: 'Sign in', steps: [{ kind: 'replay', flow: 'signin' }] },
      { id: 'refund', title: 'Refund', steps: [{ kind: 'replay', flow: 'refund' }] },
    ],
    lanes: [{ id: 'A', journeys: ['signin', 'refund'] }],
  };

  it('reports every journey blocked, with the reason, against the plan id', async () => {
    const posted: { url: string; body: string }[] = [];
    await reportPlanBlocked(
      { url: 'https://p', apiKey: 'k' },
      'hp_1',
      'The Reticle Harness is off for this project.',
      (url, init) => {
        if ('POST' === init.method)
          posted.push({ url, body: 'string' === typeof init.body ? init.body : '' });
        return Promise.resolve(new Response(JSON.stringify({ planId: 'hp_1', script: saved })));
      },
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('https://p/v1/harness/scripts/hp_1/results');
    expect(JSON.parse(posted[0]?.body ?? '{}')).toEqual({
      results: [
        {
          id: 'signin',
          title: 'Sign in',
          status: 'blocked',
          line: 'The Reticle Harness is off for this project.',
        },
        {
          id: 'refund',
          title: 'Refund',
          status: 'blocked',
          line: 'The Reticle Harness is off for this project.',
        },
      ],
    });
  });

  it('tells a replay-only plan from one with anything to drive, branches included', () => {
    const parsed = DriveScriptSchema.parse(saved);
    expect(drivesNothing(parsed)).toBe(true);
    const branched = DriveScriptSchema.parse({
      ...saved,
      journeys: [
        {
          id: 'signin',
          title: 'Sign in',
          steps: [
            { kind: 'checkpoint', id: 'c', reenter: { flow: 'signin', to: 1 } },
            {
              kind: 'branch',
              at: 'c',
              cases: [
                { label: 'a', steps: [{ kind: 'replay', flow: 'signin' }] },
                { label: 'b', steps: [{ kind: 'act', goal: 'try a wrong password' }] },
              ],
            },
          ],
        },
        saved.journeys[1],
      ],
    });
    expect(drivesNothing(branched)).toBe(false);
  });
});

/*
 * A re-drive: a plan's first run passed its journey and saved two flows; reruns 3 and 4 re-drove it
 * with the model ("0 replayed · 1 driven", ~64k tokens) and failed twice. A journey that passed
 * before replays the flows it saved, and the model drives its goal only if those decide nothing.
 */
describe('a rerun of a plan', () => {
  const script = DriveScriptSchema.parse({
    version: 1,
    source: 'platform',
    lanes: [{ id: 'A', journeys: ['goal-1', 'goal-2'] }],
    journeys: [
      { id: 'goal-1', title: 'Save', steps: [{ kind: 'act', goal: 'save "Order 7"' }] },
      { id: 'goal-2', title: 'Reload', steps: [{ kind: 'act', goal: 'reload, "Order 7"' }] },
    ],
  });

  it('replays the flows of a journey that passed before, with its goal as the fallback', () => {
    const plan = {
      runs: [
        { at: 1, results: [{ id: 'goal-1', status: 'passed', flows: ['home', 'saved-items'] }] },
        { at: 2, results: [{ id: 'goal-1', status: 'failed', by: 'model' }] },
      ],
    };
    const out = replayFirst(script, plan);
    expect(out.journeys[0]?.steps).toEqual([
      { kind: 'replay', flow: 'home' },
      { kind: 'replay', flow: 'saved-items' },
    ]);
    expect(out.journeys[0]?.fallback).toEqual({ goal: 'save "Order 7"' });
    // Never passed: driven as planned.
    expect(out.journeys[1]?.steps).toEqual([{ kind: 'act', goal: 'reload, "Order 7"' }]);
  });

  it('leaves a plan with no history as it is', () => {
    expect(replayFirst(script, {})).toEqual(script);
  });
});

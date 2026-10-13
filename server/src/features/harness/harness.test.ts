import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import {
  FINISH_TOOL,
  MSG_OPENED_IN_PLACE,
  MSG_REPEAT_CHANGED_NOTHING,
  StopReason,
  runHarness,
  systemPrompt,
  type HarnessTool,
  type HarnessToolset,
  type ModelDriver,
  type ModelTurn,
  type ToolRequest,
} from './harness.js';

const SNAPSHOT: HarnessTool = {
  name: 'reticle_snapshot',
  description: 'look at the page',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** A model that replays a fixed list of turns. No API key, no network, no clock. */
function scripted(turns: readonly ModelTurn[]): ModelDriver {
  let next = 0;
  return {
    turn(): Promise<ModelTurn> {
      const turn = turns[next] ?? { text: 'nothing left', calls: [] };
      next += 1;
      return Promise.resolve(turn);
    },
  };
}

function call(name: string, args: Record<string, unknown> = {}): ToolRequest {
  return { id: `call-${name}`, name, args };
}

function toolset(invoke: HarnessToolset['invoke']): HarnessToolset {
  return { tools: [SNAPSHOT], invoke };
}

const OK = (): Promise<unknown> => Promise.resolve({ ok: true });

describe('the harness loop', () => {
  it('finishes when the model says it is done after proving something, and keeps its summary', async () => {
    const result = await runHarness(
      scripted([
        {
          text: '',
          calls: [
            call(ReticleTool.ACT_AND_WAIT, {
              ref: 'e1',
              action: 'click',
              until: { kind: 'text', text: 'Welcome' },
            }),
          ],
        },
        { text: 'done', calls: [call(FINISH_TOOL.name, { summary: 'drove login' })] },
      ]),
      toolset(OK),
    );

    expect(result.stopReason).toBe(StopReason.FINISHED);
    expect(result.summary).toBe('drove login');
    expect(result.steps).toBe(2);
    expect(result.proved).toBe(true);
  });

  /**
   * A real drive asked to "click the counter twice and check it reads 2" clicked once, asserted
   * nothing, finished, and saved a flow whose replay verifies nothing. Finishing before anything is
   * proved is refused once, with the move that would prove it.
   */
  it('refuses a finish that proved nothing, once, and says how to prove it', async () => {
    const seen: string[] = [];
    const driver: ModelDriver = {
      turn: ({ history }) => {
        const last = history[history.length - 1];
        if ('tool' === last?.role) seen.push(JSON.stringify(last.outcomes.map((o) => o.result)));
        return Promise.resolve({
          text: '',
          calls: [call(FINISH_TOOL.name, { summary: 'clicked it' })],
        });
      },
    };
    const result = await runHarness(driver, toolset(OK));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(ReticleTool.ACT_AND_WAIT);
    expect(seen[0]).toContain('until');
    // Asked once, not forever: the second finish ends the drive, honestly marked as unproved.
    expect(result.stopReason).toBe(StopReason.FINISHED);
    expect(result.steps).toBe(2);
    expect(result.proved).toBe(false);
  });

  it('runs a check sent in the same turn as finish, and accepts the finish it proves', async () => {
    const result = await runHarness(
      scripted([
        {
          text: '',
          calls: [
            call(ReticleTool.ACT_AND_WAIT, {
              ref: 'e1',
              action: 'click',
              until: { kind: 'text', text: '2' },
            }),
            call(FINISH_TOOL.name, { summary: 'clicked twice' }),
          ],
        },
      ]),
      toolset(OK),
    );
    expect(result.stopReason).toBe(StopReason.FINISHED);
    expect(result.steps).toBe(1);
    expect(result.proved).toBe(true);
  });

  it('does not count a check that errored as proof', async () => {
    const result = await runHarness(
      scripted([
        { text: '', calls: [call(ReticleTool.ASSERT, { action: 'now' })] },
        { text: '', calls: [call(FINISH_TOOL.name, { summary: 'done' })] },
        { text: '', calls: [call(FINISH_TOOL.name, { summary: 'done' })] },
      ]),
      toolset((name) =>
        ReticleTool.ASSERT === name ? Promise.reject(new Error('no session')) : OK(),
      ),
    );
    expect(result.proved).toBe(false);
    expect(result.steps).toBe(3);
  });

  it('answers every call the model asked for, failures included', async () => {
    const result = await runHarness(
      scripted([
        { text: '', calls: [call('reticle_snapshot'), call('reticle_boom')] },
        { text: '', calls: [call(FINISH_TOOL.name, { summary: 'done' })] },
      ]),
      toolset((name) =>
        'reticle_boom' === name ? Promise.reject(new Error('no such ref')) : OK(),
      ),
    );

    expect(result.toolCalls.map((outcome) => outcome.name)).toEqual([
      'reticle_snapshot',
      'reticle_boom',
    ]);
    expect(result.toolCalls[1]?.isError).toBe(true);
    expect(result.toolCalls[1]?.result).toEqual({ error: 'no such ref' });
  });

  it('keeps the arguments, so a drive can be read back as actions', async () => {
    const result = await runHarness(
      scripted([
        { text: '', calls: [call('reticle_snapshot', { mode: 'interactive' })] },
        { text: '', calls: [call(FINISH_TOOL.name, { summary: 'done' })] },
      ]),
      toolset(OK),
    );

    expect(result.toolCalls[0]?.args).toEqual({ mode: 'interactive' });
  });

  it('stops on the step budget rather than driving forever', async () => {
    const result = await runHarness(scripted([]), toolset(OK), { maxSteps: 3 });
    // An empty script answers with no calls, which is a stall, not a budget stop — so script a
    // model that never finishes instead.
    expect(result.stopReason).toBe(StopReason.STALLED);

    const forever: ModelDriver = {
      turn: () => Promise.resolve({ text: '', calls: [call('reticle_snapshot')] }),
    };
    const capped = await runHarness(forever, toolset(OK), { maxSteps: 3 });
    expect(capped.stopReason).toBe(StopReason.BUDGET);
    expect(capped.steps).toBe(3);
    expect(capped.toolCalls).toHaveLength(3);
  });

  it('calls a model that never answers broken, and does not wait for it', async () => {
    const hung: ModelDriver = { turn: () => new Promise<ModelTurn>(() => undefined) };

    const result = await runHarness(hung, toolset(OK), { turnTimeoutMs: 5 });

    expect(result.stopReason).toBe(StopReason.BROKEN);
    expect(result.error).toContain('the model did not answer');
  });

  it('sums usage across turns, so a missed cache is visible', async () => {
    const result = await runHarness(
      scripted([
        {
          text: '',
          calls: [call('reticle_snapshot')],
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 100 },
        },
        {
          text: '',
          calls: [call(FINISH_TOOL.name, { summary: 'done' })],
          usage: { input: 3, output: 1, cacheRead: 100, cacheWrite: 0 },
        },
      ]),
      toolset(OK),
    );

    expect(result.usage).toEqual({ input: 13, output: 3, cacheRead: 100, cacheWrite: 100 });
  });

  it('advertises finish alongside the toolset, so done is stated and not inferred', async () => {
    let advertised: readonly HarnessTool[] = [];
    const watching: ModelDriver = {
      turn({ tools }) {
        advertised = tools;
        return Promise.resolve({ text: '', calls: [call(FINISH_TOOL.name, { summary: 'x' })] });
      },
    };

    await runHarness(watching, toolset(OK));

    expect(advertised.map((tool) => tool.name)).toEqual(['reticle_snapshot', FINISH_TOOL.name]);
  });
});

/*
 * A persona drive clicked the logo four times on the page the logo leads to: one route change, then
 * a wrong route guess and two clicks that did nothing, every one a spent action.
 */
describe('a click that changed nothing', () => {
  const click = (ref: string): ToolRequest => ({
    id: `c-${ref}-${String(Math.random())}`,
    name: ReticleTool.ACT,
    args: { ref, action: 'click' },
  });
  const reacting = (moved: Record<string, boolean>) => {
    const ran: string[] = [];
    const invoke: HarnessToolset['invoke'] = (_name, args) => {
      const ref = String(args['ref']);
      ran.push(ref);
      return Promise.resolve({
        trace: {
          window_ms: 50,
          summary: true === moved[ref] ? { total: 3, domAdded: 3 } : { total: 1 },
        },
      });
    };
    return { ran, invoke };
  };

  it('is not done again until something else moves the page', async () => {
    const app = reacting({ menu: true });
    const result = await runHarness(
      scripted([
        { text: '', calls: [click('logo')] },
        { text: '', calls: [click('logo')] },
        { text: '', calls: [click('menu')] },
        { text: '', calls: [click('logo')] },
      ]),
      toolset(app.invoke),
      { maxSteps: 4 },
    );
    expect(app.ran).toEqual(['logo', 'menu', 'logo']);
    expect(result.toolCalls[1]?.result).toEqual({ error: MSG_REPEAT_CHANGED_NOTHING });
  });

  it('may be repeated when it changed the page, like a counter clicked twice', async () => {
    const app = reacting({ plus: true });
    await runHarness(
      scripted([
        { text: '', calls: [click('plus')] },
        { text: '', calls: [click('plus')] },
      ]),
      toolset(app.invoke),
      { maxSteps: 2 },
    );
    expect(app.ran).toEqual(['plus', 'plus']);
  });
});

/*
 * A persona drive clicked the account button guessing it would leave /overview; it opened a menu
 * instead, the click read as a wrong guess, and the drive abandoned the route its plan named
 * ("choose Settings") three actions into eighteen steps.
 */
describe('a click that opened something in place of the route it guessed', () => {
  it('is told that opening it is progress, and to take the item the journey names', async () => {
    const result = await runHarness(
      scripted([
        {
          text: '',
          calls: [
            {
              id: 'c1',
              name: ReticleTool.ACT_AND_WAIT,
              args: {
                ref: 'e5',
                action: 'click',
                until: { kind: 'not', predicate: { kind: 'route', contains: '/overview' } },
              },
            },
          ],
        },
      ]),
      toolset(() =>
        Promise.resolve({
          verified: 'no',
          trace: { window_ms: 80, summary: { total: 6, domAdded: 6 } },
        }),
      ),
      { maxSteps: 1 },
    );
    expect(result.toolCalls[0]?.result).toMatchObject({ next: MSG_OPENED_IN_PLACE });
  });
});

describe('the standing instruction', () => {
  // A drive told to "read the run list without opening any run" opened one, and ended on its page.
  it("holds the drive to the focus's own limits, such as not opening what it says to leave closed", () => {
    expect(systemPrompt('read the list without opening a run')).toContain('without opening a run');
    expect(systemPrompt()).toContain('do not open what it says to leave closed');
  });

  it('tells the model to record what it drives, because an unrecorded drive is paid for twice', () => {
    expect(systemPrompt()).toContain('reticle_flow_save');
  });

  it('carries the run focus when there is one, and says nothing when there is not', () => {
    expect(systemPrompt('checkout as a returning customer')).toContain(
      'checkout as a returning customer',
    );
    expect(systemPrompt()).not.toContain('Focus for this run');
  });
});

/*
 * A drive is started and polled now, so the person who started it can stop it or tell it something
 * between turns, not only flip the project-wide switch.
 */
describe('a running drive, steered between turns', () => {
  it('stops before its next turn when asked, and says it was stopped', async () => {
    let asked = false;
    const result = await runHarness(
      scripted([
        { text: '', calls: [call('reticle_snapshot')] },
        { text: '', calls: [call('reticle_snapshot')] },
      ]),
      toolset(() => {
        asked = true;
        return OK();
      }),
      { stopped: () => asked },
    );
    expect(result.stopReason).toBe(StopReason.STOPPED);
    expect(result.steps).toBe(1);
  });

  it('hands what somebody said to the model as a user turn before its next turn', async () => {
    const heard: string[] = [];
    let said = ['check the refund page too'];
    const driver: ModelDriver = {
      turn: ({ history }) => {
        for (const entry of history) if ('user' === entry.role) heard.push(entry.text);
        return Promise.resolve(
          2 > heard.length
            ? { text: '', calls: [call('reticle_snapshot')] }
            : { text: '', calls: [] },
        );
      },
    };
    await runHarness(driver, toolset(OK), {
      inbox: () => {
        const taken = said;
        said = [];
        return taken;
      },
    });
    expect(heard).toContain('check the refund page too');
  });
});

/*
 * Re-drive (persona 07): the drive spent three actions on Impact clicking controls it guessed would
 * lead to Issues, before it took the Issues link — the map already knew `/issues`. The known pages
 * come first: named up front, and named again, with the way there, after a guess that missed.
 */
describe('a route the map already knows', () => {
  const ROUTES = ['/overview', '/impact', '/issues'];
  const guess = (until: unknown): ModelTurn => ({
    text: '',
    calls: [
      { id: 'g1', name: ReticleTool.ACT_AND_WAIT, args: { ref: 'e9', action: 'click', until } },
    ],
  });
  const missed = (): Promise<unknown> =>
    Promise.resolve({ verified: 'no', trace: { window_ms: 80, summary: { total: 0 } } });

  it('is named in the standing instruction before any guess', () => {
    const prompt = systemPrompt(undefined, ROUTES);
    expect(prompt).toContain('/issues');
    expect(prompt).toContain('reticle_navigate');
  });

  it('is offered by its route after a guess at it missed', async () => {
    const result = await runHarness(
      scripted([guess({ kind: 'route', pathname: '/issues' })]),
      toolset(missed),
      { maxSteps: 1, routes: ROUTES },
    );
    const next = String((result.toolCalls[0]?.result as { next?: unknown }).next);
    expect(next).toContain('reticle_navigate { url: "/issues" }');
  });

  it('lists the known pages after a guess at a route the map does not know', async () => {
    const result = await runHarness(
      scripted([guess({ kind: 'route', contains: '/issue-list' })]),
      toolset(missed),
      { maxSteps: 1, routes: ROUTES },
    );
    const next = String((result.toolCalls[0]?.result as { next?: unknown }).next);
    expect(next).toContain('/overview, /impact, /issues');
  });

  it('says nothing extra when the guess held', async () => {
    const result = await runHarness(
      scripted([guess({ kind: 'route', pathname: '/issues' })]),
      toolset(() => Promise.resolve({ verified: 'yes' })),
      { maxSteps: 1, routes: ROUTES },
    );
    expect(result.toolCalls[0]?.result).not.toHaveProperty('next');
  });
});

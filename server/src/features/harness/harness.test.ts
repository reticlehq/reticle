import { describe, expect, it } from 'vitest';
import {
  FINISH_TOOL,
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
  it('finishes when the model says it is done, and keeps its summary', async () => {
    const result = await runHarness(
      scripted([{ text: 'done', calls: [call(FINISH_TOOL.name, { summary: 'drove login' })] }]),
      toolset(OK),
    );

    expect(result.stopReason).toBe(StopReason.FINISHED);
    expect(result.summary).toBe('drove login');
    expect(result.steps).toBe(1);
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

describe('the standing instruction', () => {
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

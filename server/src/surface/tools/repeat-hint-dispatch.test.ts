/**
 * An agent that makes the same call again and again, with the same result, gets ONE hint on the
 * third call that says what to try instead.
 *
 * In the field, agents made the same call five times or more in a row: `act_and_wait`, `look` and
 * `session` most often. Each answer was the same, and nothing in it said that the call was a repeat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ReticleTool, Verified } from '@reticlehq/core';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';
import { EnvelopeKey } from './tool-kit.js';
import { buildErrorPayload } from './error-recovery.js';
import { RepeatHint, resetRepeatHints, withRepeatHint } from './repeat-hint.js';
import { resolveTargetRef } from './act/resolve-target.js';

const NO_TAB: Partial<SessionManager> = {
  resolve: () => {
    throw new Error('no browser session connected');
  },
  list: () => [],
};

function depsFor(attachId: string): ToolDeps {
  return { sessions: NO_TAB as SessionManager, attachId } as unknown as ToolDeps;
}

function toolAnswering(name: string, answer: () => Record<string, unknown>): ToolDef {
  return { name, description: '', inputSchema: {}, handler: () => Promise.resolve(answer()) };
}

const UNKNOWN = { verified: Verified.UNKNOWN, because: 'the page never settled' };
const hintOf = (result: unknown): unknown =>
  (result as Record<string, unknown>)[EnvelopeKey.REPEAT_HINT];

beforeEach(() => resetRepeatHints());

describe('the repeat hint at the dispatcher', () => {
  it('rides on the third identical call with the same verdict, once, and not on the fourth', async () => {
    const tool = toolAnswering(ReticleTool.ACT_AND_WAIT, () => ({ ...UNKNOWN }));
    const deps = depsFor('conn-1');
    const args = { ref: 'e3', action: 'click', until: { text: 'Saved' } };
    const hints: unknown[] = [];
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Key order is not part of the call: the agent may spell the same call either way.
      const spelled = 0 === i % 2 ? args : { until: args.until, action: 'click', ref: 'e3' };
      const result = (await runTool(tool, deps, spelled)) as Record<string, unknown>;
      results.push(result);
      hints.push(hintOf(result));
    }
    expect(hints[0]).toBeUndefined();
    expect(hints[1]).toBeUndefined();
    expect(hints[2]).toEqual(RepeatHint.verdict(Verified.UNKNOWN, UNKNOWN.because));
    expect(hints[3]).toBeUndefined();
    expect(hints[4]).toBeUndefined();
    // The verdict is never changed by the hint.
    for (const result of results) {
      expect(result['verified']).toBe(Verified.UNKNOWN);
      expect(result['because']).toBe(UNKNOWN.because);
    }
  });

  it('starts again when an argument changes', async () => {
    const tool = toolAnswering(ReticleTool.ACT_AND_WAIT, () => ({ ...UNKNOWN }));
    const deps = depsFor('conn-1');
    await runTool(tool, deps, { ref: 'e3' });
    await runTool(tool, deps, { ref: 'e3' });
    await runTool(tool, deps, { ref: 'e4' });
    expect(hintOf(await runTool(tool, deps, { ref: 'e4' }))).toBeUndefined();
    expect(hintOf(await runTool(tool, deps, { ref: 'e4' }))).toBeDefined();
  });

  it('starts again when the outcome changes', async () => {
    let verified: string = Verified.UNKNOWN;
    const tool = toolAnswering(ReticleTool.ACT_AND_WAIT, () => ({ verified, because: 'b' }));
    const deps = depsFor('conn-1');
    await runTool(tool, deps, { ref: 'e3' });
    await runTool(tool, deps, { ref: 'e3' });
    verified = Verified.NO;
    expect(hintOf(await runTool(tool, deps, { ref: 'e3' }))).toBeUndefined();
    expect(hintOf(await runTool(tool, deps, { ref: 'e3' }))).toBeUndefined();
    expect(hintOf(await runTool(tool, deps, { ref: 'e3' }))).toBeDefined();
  });

  it('counts each connection alone: two agents that take turns do not trigger each other', async () => {
    const tool = toolAnswering(ReticleTool.ACT_AND_WAIT, () => ({ ...UNKNOWN }));
    const a = depsFor('conn-a');
    const b = depsFor('conn-b');
    const seen: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      seen.push(hintOf(await runTool(tool, a, { ref: 'e3' })));
      seen.push(hintOf(await runTool(tool, b, { ref: 'e3' })));
    }
    expect(seen.every((hint) => hint === undefined)).toBe(true);
    // Each agent's own third call is its first repeat streak to reach three.
    expect(hintOf(await runTool(tool, a, { ref: 'e3' }))).toBeDefined();
    expect(hintOf(await runTool(tool, b, { ref: 'e3' }))).toBeDefined();
  });

  it('says the page did not change when a look gets the same answer three times', async () => {
    const tool = toolAnswering(ReticleTool.LOOK, () => ({ tree: '- button "Save" [ref=e3]' }));
    const deps = depsFor('conn-1');
    await runTool(tool, deps, { action: 'page' });
    await runTool(tool, deps, { action: 'page' });
    expect(hintOf(await runTool(tool, deps, { action: 'page' }))).toBe(RepeatHint.LOOK_SAME);
  });

  it('gives no hint to a look whose answer changed', async () => {
    let n = 0;
    const tool = toolAnswering(ReticleTool.LOOK, () => ({ tree: `- text "${String((n += 1))}"` }));
    const deps = depsFor('conn-1');
    for (let i = 0; i < 4; i += 1) {
      expect(hintOf(await runTool(tool, deps, { action: 'page' }))).toBeUndefined();
    }
  });

  it('tells a refused no_match call to take a fresh ref, on the error the boundary answers with', async () => {
    const tool: ToolDef = {
      name: ReticleTool.ACT,
      description: '',
      inputSchema: {},
      handler: () => Promise.reject(new Error('target matched no element on the page')),
    };
    const deps = depsFor('conn-1');
    const payloads: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i += 1) {
      const error: unknown = await runTool(tool, deps, { target: { text: 'Sav' } }).catch(
        (thrown: unknown) => thrown,
      );
      const message = error instanceof Error ? error.message : String(error);
      payloads.push(withRepeatHint({ ...buildErrorPayload(message) }, error));
    }
    expect(payloads.map((p) => p[EnvelopeKey.REPEAT_HINT])).toEqual([
      undefined,
      undefined,
      RepeatHint.NO_MATCH,
      undefined,
    ]);
  });

  /** The repeat hints of four identical calls that each throw the no_match refusal for `hint`. */
  async function noMatchHints(hint: unknown): Promise<unknown[]> {
    const resolution = resolveTargetRef([], hint);
    const message = 'error' === resolution.kind ? resolution.message : '';
    const tool: ToolDef = {
      name: ReticleTool.ACT,
      description: '',
      inputSchema: {},
      handler: () => Promise.reject(new Error(message)),
    };
    const deps = depsFor('conn-1');
    const hints: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const error: unknown = await runTool(tool, deps, { target: { text: 'Sav' } }).catch(
        (thrown: unknown) => thrown,
      );
      const payload: Record<string, unknown> = withRepeatHint(
        { ...buildErrorPayload(message) },
        error,
      );
      hints.push(payload[EnvelopeKey.REPEAT_HINT]);
    }
    return hints;
  }

  it('names the first nearest ref when the no_match refusal listed nearest targets', async () => {
    const nearest = [
      { ref: 'e4', role: 'button', name: 'Save' },
      { ref: 'e9', role: 'button', name: 'Cancel' },
    ];
    const hints = await noMatchHints({ nearest });
    expect(hints).toEqual([undefined, undefined, RepeatHint.noMatchNearest('e4'), undefined]);
    expect(hints[2]).toContain('"e4"');
    expect(hints[2]).not.toContain('reticle_look');
  });

  it('keeps the look advice when the no_match refusal listed no nearest targets', async () => {
    expect(await noMatchHints(undefined)).toEqual([
      undefined,
      undefined,
      RepeatHint.NO_MATCH,
      undefined,
    ]);
  });

  it('says only that the call repeated when it has nothing more specific to say', async () => {
    const tool = toolAnswering(ReticleTool.OBSERVE, () => ({ events: [] }));
    const deps = depsFor('conn-1');
    await runTool(tool, deps, {});
    await runTool(tool, deps, {});
    expect(hintOf(await runTool(tool, deps, {}))).toBe(RepeatHint.SAME);
  });
});

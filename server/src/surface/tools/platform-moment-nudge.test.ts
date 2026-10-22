import { afterEach, describe, expect, it } from 'vitest';
import { AgentNudgeKind, ReticleTool, Verified } from '@reticlehq/core';
import {
  LONG_JOURNEY_ACTS,
  NudgeText,
  resetNudges,
  resultFailed,
  takeNudge,
  type NudgeInput,
} from './platform-moment.js';

afterEach(() => resetNudges());

function input(over: Partial<NudgeInput> = {}): NudgeInput {
  return {
    session: 'agent-1',
    root: '/app/.reticle',
    tool: ReticleTool.ACT_AND_WAIT,
    verdict: true,
    failed: false,
    linked: () => Promise.resolve(false),
    harnessOn: () => undefined,
    acted: true,
    ...over,
  };
}

describe('agent nudges', () => {
  it('unlinked: suggests reticle connect after the first verdict, once per session and project', async () => {
    expect(await takeNudge(input())).toEqual({
      kind: AgentNudgeKind.CONNECT,
      text: NudgeText.CONNECT,
    });
    expect(await takeNudge(input())).toBeUndefined();
    // Another agent session hears it once too.
    expect((await takeNudge(input({ session: 'agent-2' })))?.kind).toBe(AgentNudgeKind.CONNECT);
  });

  it('says nothing on a result that failed, and keeps the nudge for a later one', async () => {
    expect(await takeNudge(input({ failed: true }))).toBeUndefined();
    expect((await takeNudge(input()))?.kind).toBe(AgentNudgeKind.CONNECT);
  });

  it('never suggests connect once linked, and never asks to close gaps: no score gates the Harness', async () => {
    const linked = { linked: () => Promise.resolve(true) };
    expect(await takeNudge(input(linked))).toBeUndefined();
  });

  it('linked with the Harness off, suggests the user switch it on, with no setup score', async () => {
    const off = input({ linked: () => Promise.resolve(true), harnessOn: () => false });
    expect(await takeNudge(off)).toEqual({
      kind: AgentNudgeKind.SWITCH_ON,
      text: NudgeText.SWITCH_ON,
    });
    expect(NudgeText.SWITCH_ON).not.toMatch(/\d+%/);
    expect(await takeNudge(off)).toBeUndefined();
  });

  // "you have driven 1 step by hand" was said after twenty: the count was per agent connection.
  it('claims no count of steps it cannot know', () => {
    expect(NudgeText.explore()).not.toMatch(/\d+ step/);
  });

  it('with the Harness on, hands a long hand-driven journey to explore, once', async () => {
    const on = input({
      verdict: false,
      harnessOn: () => true,
      linked: () => Promise.resolve(true),
    });
    const said = [];
    for (let i = 0; i < LONG_JOURNEY_ACTS + 3; i++) said.push(await takeNudge(on));
    expect(said.filter((n) => n !== undefined)).toEqual([
      { kind: AgentNudgeKind.EXPLORE, text: NudgeText.explore() },
    ]);
  });

  it('is never said on a call that is not an agent session', async () => {
    expect(await takeNudge(input({ session: undefined }))).toBeUndefined();
  });

  it('reads a refusal, an error and a "no" verdict as failures', () => {
    expect(resultFailed({}, true)).toBe(true);
    expect(resultFailed({ ok: false }, false)).toBe(true);
    expect(resultFailed({ verified: Verified.NO }, false)).toBe(true);
    expect(resultFailed({ verified: Verified.YES }, false)).toBe(false);
  });
});

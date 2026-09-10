import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { runRoleStep, runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * #894 (half A): the destructive-action refusal is written for a LIVE call — "retry with
 * args.confirmDangerous=true" — where retrying with that arg works. During replay it does not:
 * `replayActionArgs` deliberately strips any confirmDangerous a step's own args carry (a destructive
 * confirmation must be a decision made for THIS run, never persisted into a recording) and only ever
 * restores it from the one call-level boolean the replay was given. A caller who hand-edits the flow
 * file's step args to add it gets it silently deleted, replays again, and reads the identical
 * refusal — which reads as though nothing worked, when what happened is they tried the one thing
 * that cannot work here.
 */

const DESTRUCTIVE_ERROR =
  'potentially destructive action blocked; retry with args.confirmDangerous=true';

/** A session whose ACT (and ACT_SEQUENCE) commands always refuse as destructive. */
function refusingSession(): FlowReplaySession {
  return {
    command: (name): Promise<CommandResult> => {
      if (ReticleCommand.QUERY === name) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: [{ ref: 'e1' }] },
        } as unknown as CommandResult);
      }
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: false,
        error: DESTRUCTIVE_ERROR,
      } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

describe('a destructive-action refusal during replay names the call-level fix', () => {
  it('runRoleStep: names reticle_flow_replay, not the unfollowable per-arg edit', async () => {
    const result = await runRoleStep(
      refusingSession(),
      { tool: FlowStepTool.ACT, action: ActionType.CLICK, args: {} } as unknown as FlowStep,
      0,
      { kind: AnchorKind.ROLE, role: 'button', name: 'Delete' },
      false,
      () => Promise.resolve(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('reticle_flow_replay');
    expect(result.error).toContain('confirmDangerous: true');
    // The original refusal text is still present — this is an ADDITION, not a replacement, so an
    // agent that has already learned to recognise the phrase still finds it.
    expect(result.error).toContain(DESTRUCTIVE_ERROR);
  });

  it('runSequenceStep: the same rewrite applies to a sequence sub-step refusal', async () => {
    const result = await runSequenceStep(
      refusingSession(),
      {
        tool: FlowStepTool.ACT_SEQUENCE,
        anchor: { kind: AnchorKind.ROLE, role: 'form' },
        args: {},
      },
      0,
      [
        {
          tool: FlowStepTool.ACT,
          anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'Delete' },
          action: ActionType.CLICK,
          args: {},
        },
      ],
      false,
      () => Promise.resolve(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('reticle_flow_replay');
    expect(result.error).toContain('confirmDangerous: true');
  });

  it('leaves an unrelated error completely untouched', async () => {
    const session: FlowReplaySession = {
      command: (name): Promise<CommandResult> => {
        if (ReticleCommand.QUERY === name) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: [{ ref: 'e1' }] },
          } as unknown as CommandResult);
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'a',
          ok: false,
          error: 'ref e1 no longer resolves to an element',
        } as CommandResult);
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const result = await runRoleStep(
      session,
      { tool: FlowStepTool.ACT, action: ActionType.CLICK, args: {} } as unknown as FlowStep,
      0,
      { kind: AnchorKind.ROLE, role: 'button', name: 'Save' },
      false,
      () => Promise.resolve(),
    );

    expect(result.error).toBe('ref e1 no longer resolves to an element');
  });
});

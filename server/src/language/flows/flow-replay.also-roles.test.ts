/**
 * One flow grades many builds of one spec. A spec that asks for "a link or a button" was built as a
 * button by one author and a link by another, and a role anchor names one role, so the flow failed
 * every build that chose the other (a false red on correct work). `alsoRoles` names the other roles
 * that count as the same control.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowAnchorSchema,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';

/** A page with one control: `role` named "Export CSV". */
function page(role: string): FlowReplaySession {
  return {
    command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      const matches = ReticleCommand.QUERY === name && asString(args['value']) === role;
      const result =
        ReticleCommand.QUERY === name
          ? {
              elements: matches
                ? [{ ref: asRef('e-1'), role, name: 'Export CSV', states: [], visible: true }]
                : [],
              hint: { route: '/', presentTestids: [], knownEmptyState: false },
            }
          : { dispatched: true, settled: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const flow = (alsoRoles?: string[]): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'export',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: {
        kind: AnchorKind.ROLE,
        role: 'link',
        name: 'Export CSV',
        ...(alsoRoles === undefined ? {} : { alsoRoles }),
      },
      action: ActionType.CLICK,
      args: {},
    },
  ],
});

describe('a role anchor with alsoRoles', () => {
  it('acts on a button when the flow names link and also button', async () => {
    const [step] = await replayFlow(page('button'), flow(['button']), waitForPredicate, 60);
    expect(step?.ok).toBe(true);
  });

  it('still drifts on a button when the flow names link only', async () => {
    const [step] = await replayFlow(page('button'), flow(), waitForPredicate, 60);
    expect(step?.ok).toBe(false);
  });

  it('is refused with a position, which counts in one role only', () => {
    const parsed = FlowAnchorSchema.safeParse({
      kind: AnchorKind.ROLE,
      role: 'link',
      name: 'Export CSV',
      alsoRoles: ['button'],
      nth: 0,
      of: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

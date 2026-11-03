/**
 * A replayed step reads the page before its action, for an expect that compares two readings.
 *
 * `unchanged`, `changed`, `increased` and `decreased` compare the reading after the action with the
 * reading before it. Live `act_and_wait` takes that reading. Replay did not, so every such step
 * failed with "no before-reading was taken", on a correct build as on a broken one.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  PredicateKind,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';

/** A page with one button and one paragraph; the click changes the paragraph to `after`. */
function page(before: string, after: string): FlowReplaySession {
  let text = before;
  return {
    command(name: string): Promise<CommandResult> {
      let result: unknown = {};
      if (ReticleCommand.QUERY === name) {
        // The step's anchor: the one button.
        result = {
          elements: [{ ref: 'e1', role: 'button', name: 'Reset', states: [], visible: true }],
        };
      } else if (ReticleCommand.MATCH === name) {
        // The expect's read: the one paragraph, as it is now.
        const note = { ref: 'e2', role: 'paragraph', name: '', text, states: [], visible: true };
        result = { matched: true, count: 1, fullText: true, elements: [note] };
      } else if (ReticleCommand.ACT === name || ReticleCommand.ACT_SEQUENCE === name) {
        text = after;
      }
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const flow = (property: 'unchanged' | 'changed'): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'note-holds',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'reset' },
      action: 'click',
      args: {},
      expect: {
        kind: PredicateKind.TEXT,
        scope: '[data-testid="note"]',
        self: true,
        satisfies: { property },
      },
    },
  ],
});

describe('a replayed step that compares two readings', () => {
  it('passes `unchanged` when the text held', async () => {
    const results = await replayFlow(
      page('Read only', 'Read only'),
      flow('unchanged'),
      waitForPredicate,
      200,
    );
    expect(results[0]?.drift?.reason).toBeUndefined();
    expect(results[0]?.ok).toBe(true);
  });

  it('fails `unchanged` when the text moved, and names both readings', async () => {
    const results = await replayFlow(
      page('Read only', 'Editable'),
      flow('unchanged'),
      waitForPredicate,
      200,
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.drift?.reason).toContain('Read only');
  });

  it('passes `changed` when the text moved', async () => {
    const results = await replayFlow(
      page('Read only', 'Editable'),
      flow('changed'),
      waitForPredicate,
      200,
    );
    expect(results[0]?.drift?.reason).toBeUndefined();
    expect(results[0]?.ok).toBe(true);
  });

  it('reads before a sub-step of a sequence too', async () => {
    const [own] = flow('unchanged').steps;
    if (own === undefined) {
      throw new Error('the flow has a step');
    }
    const sequence: FlowFile = {
      ...flow('unchanged'),
      steps: [{ tool: ReticleTool.ACT_SEQUENCE, anchor: own.anchor, args: {}, steps: [own] }],
    };
    const held = await replayFlow(page('Read only', 'Read only'), sequence, waitForPredicate, 200);
    expect(held[0]?.drift?.reason).toBeUndefined();
    const moved = await replayFlow(page('Read only', 'Editable'), sequence, waitForPredicate, 200);
    expect(moved[0]?.drift?.reason).toContain('Read only');
  });
});

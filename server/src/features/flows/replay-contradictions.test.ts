import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  ContradictionKind,
  EventType,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
  type ReticleEvent,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * A replay that says `ok` and nothing else cannot catch a green-but-wrong step.
 *
 * The contradiction detectors fire INDEPENDENTLY of the assertion — that is their whole reason to
 * exist. A step whose anchor resolved, whose action fired and whose declared consequence held, while
 * a request in the same window failed, is the false green this product is built to catch, and a
 * deterministic replay reported none of it.
 *
 * `reticle_act_and_wait` already returns `contradictions` for its own action window. Replay now does
 * the same per step, over the window that step already carries, so a driven step and a replayed one
 * report the same disagreements rather than only the live one doing it.
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

/** A session that replays a fixed event slice as everything that happened in every window. */
class EventfulSession implements FlowReplaySession {
  #now = 0;
  constructor(
    private readonly present: Set<string>,
    private readonly events: readonly ReticleEvent[],
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    this.#now += 5;
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.present.has(value) ? [el(`e-${value}`, value)] : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.present], knownEmptyState: false },
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [...this.events];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return this.#now;
  }
}

function flow(value: string): FlowFile {
  const step: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: [step] };
}

/** The archetype: the screen moved forward while a request in the same window failed. */
const UI_ADVANCED_OVER_A_FAILURE: ReticleEvent[] = [
  { t: 1, seq: 1, type: EventType.DOM_REMOVED, sessionId: 's', data: { path: 'li' } },
  {
    t: 2,
    seq: 2,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: { id: 'n2', method: 'POST', url: '/api/archive', status: 500, ok: false },
  },
];

describe('a replayed step reports channels that disagree', () => {
  it('reports a contradiction on a step that PASSED — that is the false green', async () => {
    const results = await replayFlow(
      new EventfulSession(new Set(['archive']), UI_ADVANCED_OVER_A_FAILURE),
      flow('archive'),
      waitForPredicate,
      FAST,
    );

    // The step itself is fine: the anchor resolved and the click fired.
    expect(results[0]?.ok).toBe(true);
    // And two channels disagree about what that click did.
    expect(results[0]?.contradictions?.map((c) => c.kind)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('omits the field entirely when the channels agree', async () => {
    // Absent, not an empty array: a field that is always present teaches a reader to skim past it,
    // and the whole value here is that its presence is the signal.
    const results = await replayFlow(
      new EventfulSession(new Set(['archive']), []),
      flow('archive'),
      waitForPredicate,
      FAST,
    );

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.contradictions).toBeUndefined();
  });
});

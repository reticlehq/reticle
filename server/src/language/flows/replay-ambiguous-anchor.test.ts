/**
 * An ambiguous anchor is DRIFT, not a note on a passing step.
 *
 * When a testid matched more than one live element, replay took `refs[0]`, acted on it, and
 * returned `ok: true` carrying the string "ambiguous testid 'x', used first match". The verdict is
 * computed from `drift` and `ok` alone — a note never touches it — so a replay that clicked row 3
 * instead of row 1 reported `status: "ok"` and `replayIsGreen()` agreed.
 *
 * That is the #270 class on the replay side: a locator resolving to a different element than the
 * one recorded, reported green. The whole promise of a replay is "it did what it did before", and
 * "we guessed, and it was probably fine" is the sentence this product exists to refuse.
 *
 * It gets its OWN reason rather than reusing `testid_not_found`, for the reason `ANCHOR_DEGRADED`
 * and `EXPECT_ELEMENT_ABSENT` already have theirs: "your element disappeared" and "your element is
 * now several elements" need different fixes. The first wants a renamed anchor; this one wants a
 * NARROWER one, and heal can only propose that if the reason says so.
 */

import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

/** `counts` maps a testid to how many live elements carry it. */
class FakeSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly counts: Map<string, number>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const n = this.counts.get(value) ?? 0;
      const elements = Array.from({ length: n }, (_, i) => el(`e-${value}-${String(i)}`, value));
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.counts.keys()], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) {
      this.acts.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): never[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

function step(value: string): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

describe('an ambiguous testid anchor', () => {
  it('drifts instead of acting on the first match and reporting ok', async () => {
    const session = new FakeSession(new Map([['row-open', 3]]));
    const steps = await replayFlow(session, flow([step('row-open')]), waitForPredicate, FAST);
    const first = steps[0];
    expect(first?.ok).toBe(false);
    expect(first?.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
  });

  it('does not dispatch the action, because which element it would hit is the open question', async () => {
    const session = new FakeSession(new Map([['row-open', 3]]));
    await replayFlow(session, flow([step('row-open')]), waitForPredicate, FAST);
    expect(session.acts).toEqual([]);
  });

  it('says how many it matched, so the fix is a narrower anchor rather than a guess', async () => {
    const session = new FakeSession(new Map([['row-open', 3]]));
    const steps = await replayFlow(session, flow([step('row-open')]), waitForPredicate, FAST);
    expect(steps[0]?.drift?.reason).toContain('3');
  });

  /** The unambiguous case must be untouched: one match still acts and still passes. */
  it('leaves a single match alone', async () => {
    const session = new FakeSession(new Map([['row-open', 1]]));
    const steps = await replayFlow(session, flow([step('row-open')]), waitForPredicate, FAST);
    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
    expect(session.acts).toEqual(['e-row-open-0']);
  });

  /** And zero matches still reports the ORIGINAL reason, not the new one. */
  it('still reports testid_not_found when nothing matched', async () => {
    const session = new FakeSession(new Map([['other', 1]]));
    const steps = await replayFlow(session, flow([step('row-open')]), waitForPredicate, FAST);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
  });
});

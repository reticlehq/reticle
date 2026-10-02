/**
 * A bug sweep gets one verdict per step; a regression flow still stops at the first break.
 *
 * The incident: driving the razorpay-blade-reticle merchant dashboard against its 23-defect ground
 * truth, `txn-sweep` — six steps, each declaring what that control SHOULD do — replayed as
 * `halted: { atStep: 0, notAttempted: 5 }`. Step 0's consequence was a defect, so the run stopped
 * on it and reported the other five defects as steps that were never attempted. Finding those five
 * then cost six more calls of hand-driving, which is the opposite of what replay is for.
 *
 * Halting was right while nothing could tell the two failures apart. `isConsequenceDrift` can: a
 * SIGNAL_NOT_OBSERVED / STATE_MISMATCH / EXPECT_ELEMENT_NOT_FOUND step resolved its anchor and ran
 * its action, so the page is exactly where the step left it and the next step is as meaningful as
 * it was going to be. A TESTID_NOT_FOUND step never found its element, so the page is somewhere the
 * flow never described and continuing would invent results rather than observe them.
 *
 * Both halves are asserted here. A `sweep` that also ran past an anchor miss would trade a missed
 * defect for a fabricated one, which is the worse bug of the two.
 */

import { describe, expect, it } from 'vitest';
import {
  asRef,
  asString,
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  isConsequenceDrift,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { FLOW_TOOLS } from './flow-tools.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

describe('isConsequenceDrift', () => {
  it('is true where the anchor resolved and only the assertion failed', () => {
    expect(isConsequenceDrift(DriftReason.SIGNAL_NOT_OBSERVED)).toBe(true);
    expect(isConsequenceDrift(DriftReason.STATE_MISMATCH)).toBe(true);
    expect(isConsequenceDrift(DriftReason.EXPECT_ELEMENT_NOT_FOUND)).toBe(true);
    // A request still on the wire is the same shape: the action ran, only the answer is missing.
    expect(isConsequenceDrift(DriftReason.NET_STILL_IN_FLIGHT)).toBe(true);
  });

  it('is false where the anchor itself was never resolved', () => {
    // These leave the page somewhere the flow never described. Sweeping past one would report
    // later steps as observations of a state nobody predicted.
    expect(isConsequenceDrift(DriftReason.TESTID_NOT_FOUND)).toBe(false);
    expect(isConsequenceDrift(DriftReason.COMPONENT_NOT_FOUND)).toBe(false);
    expect(isConsequenceDrift(DriftReason.ANCHOR_DEGRADED)).toBe(false);
  });

  it('classifies every reason the enum declares, so a new one cannot default silently', () => {
    // This used to assert `typeof isConsequenceDrift(reason) === 'boolean'`, which the function's
    // own return type already guarantees: returning `false` for an unclassified reason IS the
    // silent default the test claimed to stop, and it passed. Pinning the exact partition is what
    // reddens when a reason is added and nobody decides which side it belongs on.
    expect(Object.values(DriftReason).filter(isConsequenceDrift).sort()).toEqual(
      [
        DriftReason.SIGNAL_NOT_OBSERVED,
        DriftReason.STATE_MISMATCH,
        DriftReason.EXPECT_ELEMENT_NOT_FOUND,
        DriftReason.NET_STILL_IN_FLIGHT,
      ].sort(),
    );
  });
});

describe('reticle_flow_replay', () => {
  it('advertises sweep, and says the default is the regression answer', () => {
    const replay = FLOW_TOOLS.find((t) => ReticleTool.FLOW_REPLAY === t.name);
    expect(replay, 'reticle_flow_replay is not in FLOW_TOOLS').toBeDefined();
    const sweep = replay?.inputSchema['sweep'];
    expect(sweep, 'sweep is not advertised, so no caller can reach it').toBeDefined();
    const described = String(sweep?.description ?? '');
    // The two halves a caller has to know before they trust the output.
    expect(described).toMatch(/per step/i);
    expect(described).toMatch(/anchor/i);
  });
});

/*
 * The predicate above is only half of it. Nothing exercised the REPLAY LOOP with `sweep` set, so
 * deleting the `sweepPast` clause in flow-replay.ts left the whole suite green: the file named
 * after the feature tested a pure function and a schema description, and not the behaviour.
 *
 * The fake here is the one from flow-replay.expect-element.test.ts: a step whose own testid is
 * present resolves and is clicked, and an `expect.element` testid that is absent drifts with
 * EXPECT_ELEMENT_NOT_FOUND — a consequence drift. A step whose own testid is absent drifts with
 * TESTID_NOT_FOUND, which is the anchor half and must halt even under sweep.
 */
class SweepSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.present.has(value)
        ? [
            {
              ref: asRef(`e-${value}`),
              role: 'button',
              name: value,
              states: [],
              visible: true,
            } satisfies ElementDescriptor,
          ]
        : [];
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

/** A step that clicks `value`, optionally asserting `expectTestid` appears afterwards. */
function sweepStep(value: string, expectTestid?: string): FlowStep {
  const s: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  if (expectTestid !== undefined) s.expect = { kind: 'element', query: { testid: expectTestid } };
  return s;
}

function sweepFlow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

const SWEEP_FAST = 60;

describe('the replay loop under sweep', () => {
  // Both steps click a control that IS present; step 0 asserts a consequence that never arrives.
  const twoStepsFirstConsequenceFails = (): FlowFile =>
    sweepFlow([sweepStep('confirm', 'receipt'), sweepStep('sibling')]);

  it('halts at the first consequence drift by default, which is the regression answer', async () => {
    const session = new SweepSession(new Set(['confirm', 'sibling']));
    const results = await replayFlow(
      session,
      twoStepsFirstConsequenceFails(),
      waitForPredicate,
      SWEEP_FAST,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.drift?.reasonKind).toBe(DriftReason.EXPECT_ELEMENT_NOT_FOUND);
    // Step 1 was never driven.
    expect(session.acts).toEqual(['e-confirm']);
  });

  it('continues past it under sweep, so one run reports every defect it can reach', async () => {
    const session = new SweepSession(new Set(['confirm', 'sibling']));
    const results = await replayFlow(
      session,
      twoStepsFirstConsequenceFails(),
      waitForPredicate,
      SWEEP_FAST,
      false,
      undefined,
      { sweep: true },
    );

    // The incident: this was 1, and the other step came back as "not attempted".
    expect(results).toHaveLength(2);
    expect(results[0]?.drift?.reasonKind).toBe(DriftReason.EXPECT_ELEMENT_NOT_FOUND);
    expect(results[1]?.ok).toBe(true);
    expect(session.acts).toEqual(['e-confirm', 'e-sibling']);
  });

  it('still halts on an ANCHOR drift under sweep, rather than inventing results', async () => {
    // The negative control, and the worse bug of the two: "confirm" is absent, so its action never
    // fired and the page is somewhere the flow never described. Continuing would report step 1 as
    // an observation of a state nobody predicted.
    const session = new SweepSession(new Set(['sibling']));
    const results = await replayFlow(
      session,
      sweepFlow([sweepStep('confirm'), sweepStep('sibling')]),
      waitForPredicate,
      SWEEP_FAST,
      false,
      undefined,
      { sweep: true },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(session.acts).toHaveLength(0);
  });
});

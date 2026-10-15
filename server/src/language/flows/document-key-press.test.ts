/**
 * A document-key press is saved as a step that replays the way it ran live (#1559).
 *
 * `reticle_act { action: "press", args: { text: "Escape" } }` with no ref and no target works live:
 * `act` resolves it to the document and dispatches it with no ref. The recorder then compiled it as a
 * ref-bound step with an empty ref, which saved as the degraded `unresolved` placeholder, and every
 * replay drifted at that step with "add a data-testid", for a step that has no element to add one to.
 *
 * It is now saved under a nameless `document` ROLE anchor, not degraded, and both replay engines
 * dispatch it with no ref, alone or inside a sequence. A step that genuinely has no anchor still
 * reports `anchor_degraded`, and the `document` anchor on anything other than a document-key press
 * is never dispatched at nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DOCUMENT_ANCHOR_ROLE,
  DriftReason,
  FLOW_FILE_VERSION,
  FlowFileSchema,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { compileActStep, compileSequenceStep, replayProgram } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import type { Session } from '@/portal/session/session.js';

const FAST = 60;
const ESCAPE = { action: ActionType.PRESS, args: { text: 'Escape' } };

/** Answers every QUERY with one element per known testid, and records what was dispatched. */
class FakeSession implements FlowReplaySession {
  readonly queries: Record<string, unknown>[] = [];
  readonly acts: Record<string, unknown>[] = [];
  readonly sequences: Record<string, unknown>[][] = [];
  constructor(private readonly testids: readonly string[] = []) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      this.queries.push(args);
      const value = asString(args['value']) ?? '';
      const elements = this.testids.includes(value)
        ? [{ ref: asRef(`e-${value}`), role: 'button', name: value, states: [], visible: true }]
        : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.testids], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) this.acts.push(args);
    if (name === ReticleCommand.ACT_SEQUENCE) {
      this.sequences.push((args['steps'] as Record<string, unknown>[] | undefined) ?? []);
    }
    return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
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
  beginAction(): void {}
  finishAction(): void {}
}

/** The saved file as a later replay reads it: through the schema, as from disk. */
function saved(steps: FlowStep[]): FlowFile {
  return FlowFileSchema.parse(
    JSON.parse(JSON.stringify({ version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps })),
  );
}

describe('recording a ref-less document-key press', () => {
  it('compiles stable, under the document anchor, with the press kept as it ran', () => {
    const step = compileActStep(ESCAPE, {});
    expect(step.stable).toBe(true);
    expect(step.args).toEqual({
      by: 'role',
      value: DOCUMENT_ANCHOR_ROLE,
      action: ActionType.PRESS,
      args: { text: 'Escape' },
    });
  });

  it('saves as a nameless document anchor, not the degraded placeholder', () => {
    const flowStep = recordedStepToFlowStep(compileActStep(ESCAPE, {}));
    expect(flowStep.anchor).toEqual({ kind: AnchorKind.ROLE, role: DOCUMENT_ANCHOR_ROLE });
    expect(flowStep.degraded).toBeUndefined();
    expect(flowStep.action).toBe(ActionType.PRESS);
  });

  it('keeps a press of a non-document key ref-bound, as before', () => {
    // A letter lands in whatever has focus, so `act` refuses it without a target; it is not a
    // document press and gets no document anchor.
    const step = compileActStep({ action: ActionType.PRESS, args: { text: 'a' } }, {});
    expect(step.stable).toBe(false);
    expect(recordedStepToFlowStep(step).degraded).toBe(true);
  });
});

describe('replaying a saved document-key press', () => {
  it('dispatches the press with no ref, queries nothing, and passes', async () => {
    const session = new FakeSession();
    const flow = saved([recordedStepToFlowStep(compileActStep(ESCAPE, {}))]);

    const steps = await replayFlow(session, flow, waitForPredicate, FAST);

    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
    expect(session.queries).toEqual([]);
    expect(session.acts).toEqual([{ ref: '', action: ActionType.PRESS, args: { text: 'Escape' } }]);
  });

  it('dispatches it with no ref inside a sequence, after an anchored sub-step', async () => {
    const recorded = compileSequenceStep(
      {
        steps: [
          { ref: 'e1', action: ActionType.CLICK, args: {} },
          { action: ActionType.PRESS, args: { text: 'Escape' } },
        ],
      },
      { steps: [{ testid: 'menu-open' }, {}] },
    );
    expect(recorded.stable).toBe(true);
    const flowStep = recordedStepToFlowStep(recorded);
    expect(flowStep.degraded).toBeUndefined();
    const session = new FakeSession(['menu-open']);

    const steps = await replayFlow(session, saved([flowStep]), waitForPredicate, FAST);

    expect(steps[0]?.ok).toBe(true);
    expect(session.sequences).toEqual([
      [
        { ref: 'e-menu-open', action: ActionType.CLICK, args: {} },
        { ref: '', action: ActionType.PRESS, args: { text: 'Escape' } },
      ],
    ]);
  });

  it('replays in session too, from the compiled program', async () => {
    const session = new FakeSession();
    const results = await replayProgram(
      session as unknown as Session,
      {
        name: 'r',
        steps: [compileActStep(ESCAPE, {})],
      } as never,
    );

    expect(results).toEqual([{ tool: ReticleTool.ACT, ok: true }]);
    expect(session.acts).toEqual([{ ref: '', action: ActionType.PRESS, args: { text: 'Escape' } }]);
  });
});

describe('what still has no anchor', () => {
  it('a ref-bound element step still saves degraded and drifts as anchor_degraded', async () => {
    const flowStep = recordedStepToFlowStep(
      compileActStep({ ref: 'e9', action: ActionType.CLICK, args: {} }, {}),
    );
    expect(flowStep.degraded).toBe(true);
    const session = new FakeSession();

    const steps = await replayFlow(session, saved([flowStep]), waitForPredicate, FAST);

    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.ANCHOR_DEGRADED);
    expect(session.acts).toEqual([]);
  });

  it('a document anchor on a click is never dispatched at nothing', async () => {
    const session = new FakeSession();
    const click: FlowStep = {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.ROLE, role: DOCUMENT_ANCHOR_ROLE },
      action: ActionType.CLICK,
      args: {},
    };

    const steps = await replayFlow(session, saved([click]), waitForPredicate, FAST);

    expect(steps[0]?.ok).toBe(false);
    expect(session.acts.filter((a) => '' === a['ref'])).toEqual([]);
  });
});

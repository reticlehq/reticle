import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  IrisCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@syrin/iris-protocol';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '../events/predicate.js';
import { asString } from '../tools/tools-helpers.js';
import { IrisTool } from '../tools/tool-names.js';

/**
 * Replay must SKIP asserting a `dynamic`-marked region (the LLM-output
 * case from mark-dynamic). A step still ACTS; only the content/presence assertion of a dynamic
 * testid is skipped. A NON-dynamic missing expect testid still drifts (the skip is scoped).
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref, role: 'button', name: testid, states: [], visible: true };
}

class FakeSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === IrisCommand.QUERY) {
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
    if (name === IrisCommand.ACT) {
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

function step(value: string, expectTestid?: string): FlowStep {
  const s: FlowStep = {
    tool: IrisTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  if (expectTestid !== undefined) s.expect = { element: { testid: expectTestid } };
  return s;
}

function flow(steps: FlowStep[], dynamic?: string[]): FlowFile {
  const f: FlowFile = { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
  if (dynamic !== undefined) {
    f.dynamic = dynamic.map((value) => ({ kind: AnchorKind.TESTID, value }));
  }
  return f;
}

describe('replayFlow dynamic-region skip', () => {
  it('a dynamic-marked expect testid is NOT asserted (absent region does not fail replay)', async () => {
    // The action testid "send" resolves; its expect.element.testid "caption-text" is ABSENT but
    // marked dynamic, so its assertion is skipped → the step is OK.
    const session = new FakeSession(new Set(['send']));
    const steps = await replayFlow(
      session,
      flow([step('send', 'caption-text')], ['caption-text']),
      waitForPredicate,
      FAST,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
  });

  it('a NON-dynamic missing expect testid still drifts (skip is scoped to dynamic only)', async () => {
    const session = new FakeSession(new Set(['send', 'sibling']));
    const steps = await replayFlow(
      session,
      flow([step('send', 'caption-text')]), // caption-text absent, NOT dynamic
      waitForPredicate,
      FAST,
    );
    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.anchor).toBe('caption-text');
    // nearest computed from present testids
    expect(steps[0]?.drift?.nearest).not.toBeNull();
  });

  it('the dynamic skip does NOT stop the step action from running', async () => {
    const session = new FakeSession(new Set(['send']));
    await replayFlow(
      session,
      flow([step('send', 'caption-text')], ['caption-text']),
      waitForPredicate,
      FAST,
    );
    // The ACT on the live ref of the action anchor still fired.
    expect(session.acts).toContain('e-send');
  });
});

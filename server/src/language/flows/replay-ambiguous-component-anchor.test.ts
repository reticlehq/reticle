/**
 * A component anchor that matches several live elements is DRIFT, not a guess.
 *
 * The third and last anchor kind to get this rule, and the one where it matters most. testid got it
 * first (see `replay-ambiguous-anchor.test.ts`), role second — and the role fix was written as a copy
 * of the testid check, which is how "is this ambiguous" came to have two answers and COMPONENT none
 * at all. `runComponentStep` took `refs[0]`, dispatched, and returned `ok: true`.
 *
 * `by: QueryBy.COMPONENT` matches by component NAME. A component rendered once per row — a table's
 * action button, a card's menu — matches as many times as there are rows, so the several-match case is
 * not an edge case for this anchor kind, it is its ordinary one. And the verdict reads `drift` and
 * `ok` and nothing else: a click on row 1 where the recording meant row 3 is a green
 * indistinguishable from a replay that did what it did before.
 *
 * The three runners now share one rule (`ambiguityDrift`) and one retry predicate (`soleRef`) rather
 * than each carrying its own copy, so a fourth anchor kind cannot arrive without an answer.
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
import { runComponentStep } from './flow-step-runners.js';

function el(ref: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: 'NewDeployButton', states: [], visible: true };
}

const ANCHOR = {
  kind: AnchorKind.COMPONENT,
  component: 'NewDeployButton',
  source: { file: 'src/Deployments.tsx', line: 107 },
} as const;

const LABEL = 'NewDeployButton@Deployments.tsx:107';

/** A page carrying `count` instances of the same component, refs distinct so a dispatch is legible. */
class FakeComponentSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly count: number) {}

  /** Subclasses record through this so the list stays private to the base. */
  protected record(ref: string): void {
    this.acts.push(ref);
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const elements = Array.from({ length: this.count }, (_, i) => el(`e-${String(i)}`));
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: { elements, hint: { route: '/', presentTestids: [], knownEmptyState: false } },
      });
    }
    if (name === ReticleCommand.ACT) {
      this.record(asString(args['ref']) ?? '');
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

function step(): FlowStep {
  return { tool: ReticleTool.ACT, anchor: ANCHOR, action: ActionType.CLICK, args: {} };
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

async function replay(session: FakeComponentSession) {
  return await runComponentStep(session, step(), 0, ANCHOR, false, () => Promise.resolve());
}

describe('a component anchor that matched several live elements', () => {
  it('drifts instead of acting on the first match and reporting ok', async () => {
    const result = await replay(new FakeComponentSession(3));
    expect(result.ok).toBe(false);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
  });

  it('does not dispatch the action, because which element it would hit is the open question', async () => {
    const session = new FakeComponentSession(3);
    await replay(session);
    expect(session.acts).toEqual([]);
  });

  it('names the component as an anchor and never as a testid', async () => {
    const result = await replay(new FakeComponentSession(3));
    expect(result.drift?.reason).toContain(LABEL);
    expect(result.drift?.reason).not.toContain('testid');
  });

  it('carries the component label the step was bound to', async () => {
    const result = await replay(new FakeComponentSession(3));
    expect(result.anchor).toBe(LABEL);
  });

  /**
   * `ambiguous: true` is the field heal reads to refuse an auto-rebind, and `nearest: null` is the
   * statement that there is nothing to propose: the anchor was found, several times over.
   */
  it('marks the drift ambiguous and proposes no nearest match', async () => {
    const result = await replay(new FakeComponentSession(3));
    expect(result.drift?.ambiguous).toBe(true);
    expect(result.drift?.nearest).toBeNull();
  });

  /** The unambiguous case must be untouched: one match still acts and still passes. */
  it('leaves a single match alone', async () => {
    const session = new FakeComponentSession(1);
    const result = await replay(session);
    expect(result.ok).toBe(true);
    expect(result.drift).toBeUndefined();
    expect(session.acts).toEqual(['e-0']);
  });

  /** And zero matches still reports the ORIGINAL reason, not the new one. */
  it('still reports component_not_found when nothing matched', async () => {
    const result = await replay(new FakeComponentSession(0));
    expect(result.drift?.reasonKind).toBe(DriftReason.COMPONENT_NOT_FOUND);
  });
});

/**
 * The same rule one layer up: a REPLAY of a component-anchored step, through the dispatcher.
 *
 * `runComponentStep` being correct proves nothing about `replayFlow` routing an `AnchorKind.COMPONENT`
 * step to it — the same separation of concerns that let the role runner be fixed while the testid
 * runner had no retry at all. This also pins that the run STOPS on the drift rather than carrying on
 * to the next step against an app nobody addressed.
 */
describe('replaying a flow whose component-anchored step is ambiguous', () => {
  it('reports the drift and does not run the steps after it', async () => {
    const session = new FakeComponentSession(2);
    const steps = await replayFlow(session, flow([step(), step()]), waitForPredicate, 60);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(session.acts).toEqual([]);
  });
});

/**
 * The ambiguity can APPEAR during the one stale-ref retry, and this runner's retry was the least
 * careful of the three: it returned `refs[0]` unconditionally, with no check at all.
 *
 * The first dispatch fails as stale, the re-render lands, and the locator now names three instances
 * where it named one. Dispatching at the first of them would re-make the guess the check above exists
 * to refuse, one layer deeper, where the caller cannot see it. `soleRef` hands back a ref only when
 * the locator still names exactly one, so the step ends as a failed dispatch instead.
 */
class StaleThenAmbiguousSession extends FakeComponentSession {
  private queries = 0;
  override command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      this.queries += 1;
      const first = 1 === this.queries;
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements: (first ? ['e-orig'] : ['e-a', 'e-b', 'e-c']).map((ref) => el(ref)),
          hint: { route: '/', presentTestids: [], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) {
      // Recorded even though it FAILS: "which ref did the retry dispatch at" is the whole question,
      // and a dispatch that is never observed cannot answer it.
      this.record(asString(args['ref']) ?? '');
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: false,
        error: "ref 'e-orig' no longer resolves to an element",
      });
    }
    return super.command(name, args);
  }
}

describe('a component anchor that becomes ambiguous during the stale-ref retry', () => {
  it('does not dispatch at the first of the new matches', async () => {
    const session = new StaleThenAmbiguousSession(1);
    const result = await replay(session);
    expect(result.ok).toBe(false);
    // The original attempt only. Without the retry guard this was ['e-orig', 'e-a'] — the retry guessed.
    expect(session.acts).toEqual(['e-orig']);
  });

  /**
   * And it says SO, rather than reporting the staleness it was retrying for.
   *
   * The pair with the role file's equivalent, and the assertion that was missing here: without it,
   * `does not dispatch` above passes just as well when the step reports the original stale-ref
   * error — a sentence about an element that is GONE, sent for an element that is now three. Two
   * diagnoses with two different fixes (narrow the anchor vs. re-record the flow) would arrive as
   * one message, which is the defect `Reresolved` exists to remove.
   */
  it('reports the ambiguity as a drift, not as the stale ref it was retrying for', async () => {
    const session = new StaleThenAmbiguousSession(1);
    const result = await replay(session);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(result.drift?.ambiguous).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

/**
 * A role anchor that matches several live elements is DRIFT, not a guess.
 *
 * `runRoleStep` took `refs[0]`, dispatched, and reported `ok: true`. The testid path was fixed for
 * exactly this and the role path was not, so a flow recorded against "View result" on row 3 of a
 * table replayed by clicking row 1 — and when the consequence is shared by every row (the same GET
 * returning 200), the replay PASSED. A green verdict for an action on the wrong element is the one
 * outcome a replay exists to refuse.
 *
 * The ambiguity is worse for a role anchor than for a testid: a testid is minted by the developer as
 * an address, while `button "View result"` is user-visible text that a table repeats by nature, so
 * the several-match case is the EXPECTED shape of a recorded row action rather than an accident.
 *
 * The action is NOT dispatched. Acting and then reporting drift would leave the app changed by a
 * click nobody can attribute, which is worse than the ambiguity it reports.
 */

import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  DriftReason,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  FLOW_FILE_VERSION,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { runRoleStep } from './flow-step-runners.js';

function el(ref: string, role: string, name: string): ElementDescriptor {
  return { ref: asRef(ref), role, name, states: [], visible: true };
}

/** A page carrying `count` buttons that all answer to the same role + name. */
class FakeRoleSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly count: number) {}

  /** Subclasses record through this so the list stays private to the base. */
  protected record(ref: string): void {
    this.acts.push(ref);
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const label = asString(args['name']) ?? '';
      const elements = Array.from({ length: this.count }, (_, i) =>
        el(`e-${String(i)}`, value, label),
      );
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

const STEP = {
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'View result' },
  action: ActionType.CLICK,
  args: {},
} as unknown as FlowStep;

const ANCHOR = { kind: AnchorKind.ROLE, role: 'button', name: 'View result' } as const;

async function replay(session: FakeRoleSession) {
  return await runRoleStep(session, STEP, 0, ANCHOR, false, () => Promise.resolve());
}

function roleStep(): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'View result' },
    action: ActionType.CLICK,
    args: {},
  };
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

describe('a role anchor that matched several live elements', () => {
  it('drifts instead of acting on the first match and reporting ok', async () => {
    const result = await replay(new FakeRoleSession(3));
    expect(result.ok).toBe(false);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
  });

  it('does not dispatch the action, because which element it would hit is the open question', async () => {
    const session = new FakeRoleSession(3);
    await replay(session);
    expect(session.acts).toEqual([]);
  });

  it('says how many it matched, so the fix is a narrower anchor rather than a guess', async () => {
    const result = await replay(new FakeRoleSession(3));
    expect(result.drift?.reason).toContain('3');
  });

  /**
   * The message must name the anchor kind the reader actually has.
   *
   * The shared drift builder hardcoded the word "testid" into its prose, and a role anchor reusing it
   * would answer `testid "button "View result"" matched 3 …` — sending the reader to edit a testid
   * that does not exist on a step anchored by role. The `anchor` FIELD still carries the label; only
   * the sentence describes it.
   */
  it('names the anchor as a role anchor, not a testid', async () => {
    const result = await replay(new FakeRoleSession(3));
    expect(result.drift?.reason).toContain('role anchor');
    expect(result.drift?.reason).not.toContain('testid');
  });

  it('carries the anchor label the step was bound to', async () => {
    const result = await replay(new FakeRoleSession(3));
    expect(result.anchor).toBe('button "View result"');
  });

  /**
   * `ambiguous: true` is the field heal reads to refuse an auto-rebind. A drift that guessed and then
   * offered the guess as a rebind target would re-make the exact pick this reason exists to stop.
   */
  it('marks the drift ambiguous and proposes no nearest match', async () => {
    const result = await replay(new FakeRoleSession(3));
    expect(result.drift?.ambiguous).toBe(true);
    expect(result.drift?.nearest).toBeNull();
  });

  /** The unambiguous case must be untouched: one match still acts and still passes. */
  it('leaves a single match alone', async () => {
    const session = new FakeRoleSession(1);
    const result = await replay(session);
    expect(result.ok).toBe(true);
    expect(result.drift).toBeUndefined();
    expect(session.acts).toEqual(['e-0']);
  });

  /** And zero matches still reports the ORIGINAL reason, not the new one. */
  it('still reports component_not_found when nothing matched', async () => {
    const result = await replay(new FakeRoleSession(0));
    expect(result.drift?.reasonKind).toBe(DriftReason.COMPONENT_NOT_FOUND);
  });
});

/**
 * The ambiguity can APPEAR during the one stale-ref retry, and that path must refuse it too.
 *
 * The step resolves one element, dispatch fails as stale, the DOM re-renders — and now the locator
 * names three. The retry re-resolves and this path took `refs[0]` as well, so the fix would have been
 * one layer deep only: exactly the shape of defect the first version of this runner had. The testid
 * retry hands back a ref only when the locator still names exactly one, and these two runners are
 * supposed to answer identically.
 */
/**
 * The refs are DISTINCT per query so the assertion can tell which one was dispatched at. An earlier
 * draft reused ref `e-0` for every match AND swallowed the dispatch, so `acts` was empty no matter
 * what the runner did — the test passed against the unfixed code, which is the one thing a test may
 * never do.
 */
class StaleThenAmbiguousSession extends FakeRoleSession {
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
          elements: (first ? ['e-orig'] : ['e-a', 'e-b', 'e-c']).map((ref) =>
            el(ref, 'button', 'View result'),
          ),
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

describe('a role anchor that becomes ambiguous during the stale-ref retry', () => {
  it('does not dispatch at the first of the new matches', async () => {
    const session = new StaleThenAmbiguousSession(1);
    const result = await replay(session);
    expect(result.ok).toBe(false);
    // The original attempt only. Before the fix this was ['e-orig', 'e-a'] — the retry guessed.
    expect(session.acts).toEqual(['e-orig']);
  });

  /**
   * And it says SO, rather than reporting the staleness it was retrying for.
   *
   * These are two diagnoses with two different fixes. "The ref went stale" means the page re-rendered
   * and the retry exists to absorb exactly that; "the anchor now names three elements" means the
   * recording cannot be replayed as written and the anchor has to be narrowed. Both arrive as
   * `ok: false`, and before this the second was reported in the words of the first — `error: "ref
   * 'e-orig' no longer resolves to an element"` — sending the reader after a rename that is not the
   * problem. `ANCHOR_AMBIGUOUS` exists as its own reason kind precisely so the two cannot be confused.
   */
  it('reports the ambiguity as a drift, not as the stale ref it was retrying for', async () => {
    const session = new StaleThenAmbiguousSession(1);
    const result = await replay(session);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(result.drift?.ambiguous).toBe(true);
    expect(result.drift?.reason).toContain('3');
    expect(result.error).toBeUndefined();
  });

  /** A retry that finds the element gone is still the stale-ref failure it always was. */
  it('still reports a failed dispatch when the element is genuinely gone', async () => {
    // The count is unused: this subclass answers QUERY itself. Passed for the inherited constructor.
    const session = new GoneAfterRerenderSession(1);
    const result = await replay(session);
    expect(result.ok).toBe(false);
    expect(result.drift).toBeUndefined();
    expect(result.error).toContain('no longer resolves');
  });
});

/**
 * The other way the retry comes up empty: the element is gone, not multiplied.
 *
 * The pair with the ambiguity case above is the point — both hand `undefined`-shaped answers back to
 * `actOnResolvedRef` in the version that collapsed them, and a fix that turned EVERY empty retry into
 * a drift would be wrong in the opposite direction.
 */
class GoneAfterRerenderSession extends FakeRoleSession {
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
          elements: (first ? ['e-orig'] : []).map((ref) => el(ref, 'button', 'View result')),
          hint: { route: '/', presentTestids: [], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) {
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

/**
 * The same rule one seam up, where the issue is actually stated: a REPLAY of a role-anchored step.
 *
 * The runner tests above pin the decision; this pins that the replay path routes a named role anchor
 * here at all (the dispatcher sends nameless ROLE anchors down the degraded path), and that the run
 * STOPS on the drift rather than carrying on to the next step against an app nobody addressed.
 *
 * Mirrors `replay-ambiguous-anchor.test.ts`, which does this for testid — the two anchor kinds are
 * supposed to answer identically, so the tests are supposed to look identical.
 */
describe('replaying a flow whose role-anchored step is ambiguous', () => {
  it('reports the drift and does not run the steps after it', async () => {
    const session = new FakeRoleSession(3);
    const steps = await replayFlow(session, flow([roleStep(), roleStep()]), waitForPredicate, 60);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(session.acts).toEqual([]);
  });
});

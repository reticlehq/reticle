import { FlowStepTool, type FlowExpect } from '@reticlehq/core';

/** One captured agent action, normalized for replay. */
export interface RecordedStep {
  /** ReticleTool.ACT | ReticleTool.ACT_SEQUENCE */
  tool: string;
  /** Normalized args: refs replaced by { by:'testid', value } where resolvable. */
  args: Record<string, unknown>;
  /** false if any ref could not be normalized to a testid (replay only valid in-session). */
  stable: boolean;
  /** Optional post-condition annotation carried into the on-disk flow's expect. */
  expect?: FlowExpect;
  /**
   * The document this step runs, when the step is an INVOCATION rather than an action.
   *
   * Written by `stop` when a nested recording closes inside an outer one. `tool` and `args` are
   * still present and still describe nothing the replayer should dispatch — a consumer reads
   * `invoke` first and treats the step as a call.
   */
  invoke?: string;
}

interface ActiveRecording {
  cursor: number;
  steps: RecordedStep[];
  /** The route the journey began on. See CompiledProgram.startPath. */
  startPath?: string;
  /**
   * For each recording that was ALREADY in flight when this one started, how many steps it had.
   *
   * That mark is what makes a sub-flow boundary knowable. `capture` appends to every active
   * recording, so a nested span lands in the outer one INLINED — which is a composite-shaped
   * journey with none of composition's value: the drift still reports "step 34 of onboarding",
   * repair still has to happen in every copy, and the sub-journey cannot be reused. With the mark,
   * `stop` can replace exactly the span it owns with a single invocation.
   *
   * Recorded at START rather than derived at stop, because by then the outer recording has grown
   * and there is nothing left to say where this one began.
   */
  openedOver: ReadonlyMap<string, number>;
}

/** A finished, replayable program compiled from a recording. */
export interface CompiledProgram {
  name: string;
  version: number;
  steps: RecordedStep[];
  /*
   * The route recording STARTED on, so a saved flow can navigate there before step 1.
   *
   * Without it a replay begins wherever the page happens to be, and a first step whose whole
   * consequence is "this navigation fetches" quietly fetches nothing when replay is already on the
   * destination — the flow then fails for a reason that has nothing to do with the app. The human
   * recorder has always captured this; the agent's did not, so agent-recorded flows were replayable
   * only from the page they were recorded on. Observed: a green recording went red on replay purely
   * because it started one route further along.
   */
  startPath?: string;
  /**
   * Pages the recording sat on, in order, consecutive stays collapsed. In-memory only — not written
   * to the flow file. Lets save warn about a backtrack (a journey that cannot replay) without a
   * format change.
   */
  routes?: string[];
}

/**
 * The `tool` written on an invocation step — core's constant, re-exported for this module's callers.
 *
 * NOT a second spelling. It crosses the recorder, the saved file and the replayer, and core is where
 * a string that crosses those is defined; a local copy is a rename away from a recorder that writes
 * what no replayer reads, which is the drift `FlowStepTool` was created to end.
 */
export const INVOKE_TOOL: string = FlowStepTool.INVOKE;

/**
 * Tracks in-flight recordings (name -> { buffer cursor at record_start, captured steps })
 * and the last compiled program per name (for reticle_replay).
 */
export class RecordingStore {
  readonly #active = new Map<string, ActiveRecording>();
  readonly #compiled = new Map<string, CompiledProgram>();

  start(name: string, cursor: number, startPath?: string): void {
    const openedOver = new Map<string, number>();
    for (const [outer, rec] of this.#active) openedOver.set(outer, rec.steps.length);
    this.#active.set(name, {
      cursor,
      steps: [],
      openedOver,
      ...(startPath === undefined ? {} : { startPath }),
    });
  }

  isRecording(name: string): boolean {
    return this.#active.has(name);
  }

  /**
   * Number of steps captured so far in the named ACTIVE recording (0 if it
   * exists but is empty, undefined if there is no active recording by that name). Lets the annotate
   * compiler target the LAST captured step without exposing the mutable step array.
   */
  stepCount(name: string): number | undefined {
    return this.#active.get(name)?.steps.length;
  }

  /** Append a captured step to every active recording (steps belong to all in-flight spans). */
  capture(step: RecordedStep): void {
    for (const rec of this.#active.values()) rec.steps.push(step);
  }

  /**
   * Returns the active recording (cursor + steps) and clears it, or undefined if not recording.
   *
   * Closing a NESTED recording also rewrites its parents: the span this recording owned is replaced
   * in each still-open outer recording by one `invoke` step. That is the moment a sub-flow boundary
   * becomes knowable — the sub-journey is complete and it has a name, neither of which was true
   * when it started.
   *
   * Only recordings this one opened OVER are rewritten. Overlapping spans are not nesting: a
   * recording that began before this one did not contain it, and a document that invokes something
   * it never drove replays a journey nobody took.
   */
  stop(name: string): ActiveRecording | undefined {
    const rec = this.#active.get(name);
    this.#active.delete(name);
    if (rec === undefined) return undefined;
    for (const [outer, mark] of rec.openedOver) {
      const parent = this.#active.get(outer);
      // Gone already, or somehow shorter than when we started: leave it exactly as it is rather
      // than splice a range that no longer means what it meant.
      if (parent === undefined || parent.steps.length < mark) continue;
      parent.steps.splice(mark, parent.steps.length - mark, {
        tool: INVOKE_TOOL,
        args: { flow: name },
        stable: true,
        invoke: name,
      });
    }
    return rec;
  }

  saveCompiled(program: CompiledProgram): void {
    this.#compiled.set(program.name, program);
  }

  getCompiled(name: string): CompiledProgram | undefined {
    return this.#compiled.get(name);
  }

  active(): string[] {
    return [...this.#active.keys()];
  }

  /**
   * Names of recordings that have been STOPPED and compiled.
   *
   * The mirror of `active()`, and needed for the same defaulting: after `reticle_record stop` a
   * recording is no longer active, so resolving "the obvious one" from `active()` finds nothing.
   * Saving it then demanded the exact name back from the caller, which is a thing to remember for
   * no reason when exactly one recording exists.
   */
  compiled(): string[] {
    return [...this.#compiled.keys()];
  }
}

import type { FlowExpect } from '@reticlehq/core';

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
}

interface ActiveRecording {
  cursor: number;
  steps: RecordedStep[];
  /** True once the step cap refused further captures — stop is still required to compile. */
  capped?: boolean;
}

/** A finished, replayable program compiled from a recording. */
export interface CompiledProgram {
  name: string;
  version: number;
  steps: RecordedStep[];
}

/**
 * Hard cap on steps per active recording. A forgotten `reticle_record` over a long crawl used to
 * grow without bound (the event ring buffer is capped; recordings were not) and could OOM the daemon.
 */
export const MAX_RECORDING_STEPS = 500;

/**
 * Tracks in-flight recordings (name -> { buffer cursor at record_start, captured steps })
 * and the last compiled program per name (for reticle_replay).
 */
export class RecordingStore {
  readonly #active = new Map<string, ActiveRecording>();
  readonly #compiled = new Map<string, CompiledProgram>();

  start(name: string, cursor: number): void {
    this.#active.set(name, { cursor, steps: [] });
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

  /**
   * Append a captured step to every active recording that is under the step cap.
   * Once a recording hits `MAX_RECORDING_STEPS`, further captures are refused for that span
   * (the recording stays open so stop/save still works).
   */
  capture(step: RecordedStep): void {
    for (const rec of this.#active.values()) {
      if (rec.steps.length >= MAX_RECORDING_STEPS) {
        rec.capped = true;
        continue;
      }
      rec.steps.push(step);
      if (rec.steps.length >= MAX_RECORDING_STEPS) rec.capped = true;
    }
  }

  /** Returns the active recording (cursor + steps) and clears it, or undefined if not recording. */
  stop(name: string): ActiveRecording | undefined {
    const rec = this.#active.get(name);
    this.#active.delete(name);
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
}

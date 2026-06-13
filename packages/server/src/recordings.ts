import type { FlowExpect } from '@syrin/protocol';

/** One captured agent action, normalized for replay (G6). */
export interface RecordedStep {
  /** IrisTool.ACT | IrisTool.ACT_SEQUENCE */
  tool: string;
  /** Normalized args: refs replaced by { by:'testid', value } where resolvable. */
  args: Record<string, unknown>;
  /** false if any ref could not be normalized to a testid (replay only valid in-session). */
  stable: boolean;
  /** M8 FLOWFMT: optional post-condition annotation carried into the on-disk flow's expect. */
  expect?: FlowExpect;
}

interface ActiveRecording {
  cursor: number;
  steps: RecordedStep[];
}

/** A finished, replayable program compiled from a recording. */
export interface CompiledProgram {
  name: string;
  version: number;
  steps: RecordedStep[];
}

/**
 * Tracks in-flight recordings (name -> { buffer cursor at record_start, captured steps })
 * and the last compiled program per name (for iris_replay). See plan/05 + G6.
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
   * M8 Stage B ANNOTATE: number of steps captured so far in the named ACTIVE recording (0 if it
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

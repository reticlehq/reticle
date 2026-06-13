import type { FlowExpect } from '@syrin/iris-protocol';

/**
 * Holds the flow-level + per-step annotations accumulating during a live
 * recording, keyed by recording name. A CompiledProgram (RecordingStore) carries only steps; the
 * annotations the human/agent attaches (dynamic[], success, per-step expect) live here until
 * iris_flow_save folds them into the on-disk FlowFile.
 *
 * Pure in-memory state — no IO, no clock. One bucket per recording name; cleared on save so a fresh
 * recording of the same name never inherits stale annotations.
 */
interface FlowAnnotationBucket {
  dynamic: string[];
  success?: FlowExpect;
  stepExpect: Map<number, FlowExpect>;
}

export class AnnotationStore {
  readonly #byName = new Map<string, FlowAnnotationBucket>();

  #bucket(name: string): FlowAnnotationBucket {
    let bucket = this.#byName.get(name);
    if (bucket === undefined) {
      bucket = { dynamic: [], stepExpect: new Map() };
      this.#byName.set(name, bucket);
    }
    return bucket;
  }

  /** Testids whose CONTENT must not be asserted at replay (mark-dynamic). Copy, never the live array. */
  dynamic(name: string): string[] {
    return [...(this.#byName.get(name)?.dynamic ?? [])];
  }

  /** The flow's golden end-condition (success-state), or undefined. */
  success(name: string): FlowExpect | undefined {
    return this.#byName.get(name)?.success;
  }

  /** Per-step expect predicates compiled from assert-* annotations, keyed by step index. */
  stepExpect(name: string): Map<number, FlowExpect> {
    const source = this.#byName.get(name)?.stepExpect;
    return source === undefined ? new Map<number, FlowExpect>() : new Map(source);
  }

  /** Append a dynamic testid (mark-dynamic). De-duped so repeated marks stay idempotent. */
  addDynamic(name: string, testid: string): void {
    const bucket = this.#bucket(name);
    if (!bucket.dynamic.includes(testid)) bucket.dynamic.push(testid);
  }

  /** Set the flow's success expectation (success-state); a later set overwrites. */
  setSuccess(name: string, expect: FlowExpect): void {
    this.#bucket(name).success = expect;
  }

  /** Set one step's expect (assert-signal / assert-visible); a later set on the same index wins. */
  setStepExpect(name: string, index: number, expect: FlowExpect): void {
    this.#bucket(name).stepExpect.set(index, expect);
  }

  /** Drop a recording's annotations (called after iris_flow_save folds them onto disk). */
  clear(name: string): void {
    this.#byName.delete(name);
  }
}

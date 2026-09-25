import {
  IntentState,
  bindIntent,
  declareIntent,
  redeclareIntent,
  dischargeIntent,
  type Intent,
  type IntentSurface,
} from '@reticlehq/core/artifacts';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { Clock } from '@/machine/clock.js';
import { IntentShardStore } from './intent-shard-store.js';

/**
 * The intent ledger's domain operations: declare, place, bind, discharge.
 *
 * Every operation is a PURE transition from core (`redeclareIntent`, `bindIntent`,
 * `dischargeIntent`) handed to the ledger's atomic upsert. Storage is `IntentShardStore` —
 * `.reticle/intent/<subject>/intent.json`, a flow's name being its subject — and this class writes no
 * file of its own, so there is exactly one place an intent can be.
 */
export class IntentStore {
  readonly #ledger: IntentShardStore;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#ledger = new IntentShardStore(fs, root, clock);
    this.#clock = clock;
  }

  /** Every intent, in declaration order. */
  async read(): Promise<Intent[]> {
    return this.#ledger.all();
  }

  /** Everything not yet proved — what an agent asking "am I done?" still owes. */
  async open(): Promise<Intent[]> {
    return (await this.read()).filter((intent) => IntentState.PROVED !== intent.state);
  }

  /**
   * Declare one or more intents.
   *
   * Batched because the marginal cost of the whole mechanism has to stay at one call per feature; an
   * agent that must make five calls to declare five things will make none. Saying an intent again
   * does not unsay it: see `redeclareIntent` for what survives.
   */
  async declare(
    entries: readonly { id: string; statement: string; surface?: IntentSurface }[],
  ): Promise<Intent[]> {
    const now = this.#clock.now();
    const declared: Intent[] = [];
    for (const entry of entries) {
      const stored = await this.#ledger.upsert(entry.id, (existing) =>
        redeclareIntent(existing, declareIntent({ ...entry, now })),
      );
      if (stored !== undefined) declared.push(stored);
    }
    return declared;
  }

  /**
   * File a record under where it turned out to be about.
   *
   * Separate from `declare` because an inline intent is declared BEFORE the action, and the route
   * that describes it only exists after the consequence lands. Write-once: an existing surface is
   * never overwritten. A flow named here moves the record into that flow's directory.
   */
  async place(id: string, surface: IntentSurface): Promise<boolean> {
    let placed = false;
    await this.#ledger.upsert(id, (existing) => {
      if (existing === undefined || existing.surface !== undefined) return undefined;
      placed = true;
      return { ...existing, surface };
    });
    return placed;
  }

  /** Attach the predicate that would prove an intent. False when the id names nothing. */
  async bind(id: string, binding: unknown): Promise<boolean> {
    const stored = await this.#ledger.upsert(id, (existing) =>
      existing === undefined ? undefined : bindIntent(existing, binding),
    );
    return stored !== undefined;
  }

  /**
   * Record that a verdict proved an intent.
   *
   * False rather than a throw on an unknown or unbound id: discharge runs off the back of a verdict,
   * and must never be the reason one fails to return.
   */
  async discharge(
    id: string,
    proof: { verdictId: string; grade: string; at: number },
  ): Promise<boolean> {
    let proved = false;
    await this.#ledger.upsert(id, (existing) => {
      if (existing === undefined) return undefined;
      const next = dischargeIntent(existing, proof);
      if (next === existing) return undefined;
      proved = true;
      return next;
    });
    return proved;
  }
}

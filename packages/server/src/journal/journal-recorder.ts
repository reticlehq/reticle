import {
  EventAttribution,
  JOURNAL_FILE_VERSION,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';

/** Where a recorder persists. `SessionJournal` satisfies this structurally. */
export interface JournalSink {
  appendEvents(events: readonly ReticleEvent[]): Promise<void>;
  appendAction(action: JournalAction): Promise<void>;
}

/** Read side of the durable journal — the fall-through source when the ring buffer has evicted. */
export interface JournalReader {
  readEvents(): Promise<ReticleEvent[]>;
  /**
   * The action ledger. Optional because a test double is a partial reader, and nothing that only
   * needs events should be forced to grow a second method to satisfy the type.
   */
  readActions?(): Promise<JournalAction[]>;
}

interface JournalRecorderOptions {
  /** Injected elapsed-ms clock (never read from Date here — the clock-injection rule). */
  now: () => number;
  /** Flush the pending-event batch once this many accumulate. */
  flushAt?: number;
}

const DEFAULT_FLUSH_AT = 64;

interface ActiveAction {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  tStart: number;
  seqFrom?: number;
  seqTo?: number;
}

/**
 * Owns action-window attribution and batched, order-preserving journaling — the durable half of the
 * causal spine, kept out of Session so neither file bloats. Every stamped event is `observe`d: if an
 * action is active (dispatch→settle), the event is attributed to it (`attribution:"window"` — a time
 * heuristic, never presented as dataflow truth) and its seq folds into the action's range. Writes are
 * serialized on one chain so `events.jsonl` never interleaves and an action is always persisted after
 * the events it closed. Sink writes are best-effort: a failed local journal write must never break the
 * live session, so errors are swallowed.
 */
export class JournalRecorder {
  readonly #sink: JournalSink;
  readonly #now: () => number;
  readonly #flushAt: number;
  #pending: ReticleEvent[] = [];
  #active: ActiveAction | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(sink: JournalSink, options: JournalRecorderOptions) {
    this.#sink = sink;
    this.#now = options.now;
    this.#flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
  }

  /** Attribute (if an action is active), enqueue for journaling, and return the possibly-stamped event. */
  observe(event: ReticleEvent): ReticleEvent {
    let out = event;
    const active = this.#active;
    if (active !== undefined) {
      out = { ...event, actionId: active.actionId, attribution: EventAttribution.WINDOW };
      if ('number' === typeof event.seq) {
        active.seqFrom =
          active.seqFrom === undefined ? event.seq : Math.min(active.seqFrom, event.seq);
        active.seqTo = active.seqTo === undefined ? event.seq : Math.max(active.seqTo, event.seq);
      }
    }
    this.#pending.push(out);
    if (this.#pending.length >= this.#flushAt) this.#enqueueFlush();
    return out;
  }

  /** Open an attribution window. One action is active at a time (the agent drives sequentially). */
  beginAction(actionId: string, tool: string, args: Record<string, unknown>): void {
    this.#active = { actionId, tool, args, tStart: this.#now() };
  }

  /** Close the active window: persist its buffered events, then the action record. No-op if none active. */
  finishAction(effect?: unknown, settled?: boolean, settledInMs?: number): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    const action: JournalAction = {
      v: JOURNAL_FILE_VERSION,
      actionId: active.actionId,
      tool: active.tool,
      args: active.args,
      effect,
      settled,
      settledInMs,
      seqRange:
        active.seqFrom === undefined || active.seqTo === undefined
          ? undefined
          : { from: active.seqFrom, to: active.seqTo },
      tRange: { from: active.tStart, to: this.#now() },
      at: active.tStart,
    };
    this.#enqueueFlush();
    this.#chain = this.#chain.then(() => this.#sink.appendAction(action)).catch(() => undefined);
  }

  /**
   * Append one action record for a tool that PROVED something without driving the page.
   *
   * `reticle_assert` produces a verdict and moves nothing, so it must never open an attribution
   * window: while one is open every observed event is stamped with that action's id, and stamping
   * ambient traffic with an assertion's id would manufacture a causal link that does not exist —
   * exactly what `EventAttribution.WINDOW` is carefully labelled to avoid claiming. So this writes
   * the record and leaves `#active` precisely as it found it: an act window open across an assert
   * keeps attributing to itself, which is the truth of what caused those events.
   *
   * `settled` is left unset for the same reason — nothing was dispatched, so there is no settle
   * outcome to report, and the run fold skips actions that state none rather than inventing one.
   *
   * Ordering rides the same chain as `finishAction`: buffered events flush first, so a record is
   * always persisted after the events that preceded it. Records land in the order verdicts were
   * REACHED, so an assert taken mid-window is written before the act it interrupted.
   */
  recordAction(
    actionId: string,
    tool: string,
    args: Record<string, unknown>,
    effect?: unknown,
  ): void {
    const at = this.#now();
    const action: JournalAction = {
      v: JOURNAL_FILE_VERSION,
      actionId,
      tool,
      args,
      effect,
      // No window was opened, so no event carries this id: `seqRange` is omitted rather than
      // invented, because any range here would claim an attribution that never happened. `tRange` is
      // required by the schema and the honest value is the instant the verdict was recorded — a span
      // of zero, which is exactly how much time this action attributed events over.
      tRange: { from: at, to: at },
      at,
    };
    this.#enqueueFlush();
    this.#chain = this.#chain.then(() => this.#sink.appendAction(action)).catch(() => undefined);
  }

  /** Persist any buffered events now (call on session end). Awaits the write chain to settle. */
  async flush(): Promise<void> {
    this.#enqueueFlush();
    await this.#chain;
  }

  #enqueueFlush(): void {
    if (0 === this.#pending.length) return;
    const batch = this.#pending;
    this.#pending = [];
    this.#chain = this.#chain.then(() => this.#sink.appendEvents(batch)).catch(() => undefined);
  }
}

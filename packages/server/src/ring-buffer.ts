import { RING_BUFFER_DEFAULTS, type IrisEvent } from '@syrin/iris-protocol';

export interface RingBufferOptions {
  maxEvents?: number;
  maxAgeMs?: number;
}

/**
 * Bounded, time-aware event store per session. The single data structure that powers
 * observe()/wait_for()/assert() — it lets us look both backward (recent buffer) and
 * forward (await new events). See plan/02-architecture.md.
 *
 * `now` is injected so the buffer is deterministically testable (engineering standard:
 * inject the clock, never call Date.now() inside logic).
 */
export class RingBuffer {
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;
  #events: IrisEvent[] = [];

  constructor(options: RingBufferOptions = {}) {
    this.#maxEvents = options.maxEvents ?? RING_BUFFER_DEFAULTS.MAX_EVENTS;
    this.#maxAgeMs = options.maxAgeMs ?? RING_BUFFER_DEFAULTS.MAX_AGE_MS;
  }

  push(event: IrisEvent, now: number): void {
    this.#events.push(event);
    this.#evict(now);
  }

  /** Events at or after a given timestamp cursor. */
  since(cursor: number): IrisEvent[] {
    return this.#events.filter((e) => e.t >= cursor);
  }

  /** Events within the last `windowMs`, relative to `now`. */
  window(windowMs: number, now: number): IrisEvent[] {
    const from = now - windowMs;
    return this.#events.filter((e) => e.t >= from);
  }

  #evict(now: number): void {
    const cutoff = now - this.#maxAgeMs;
    if (this.#events.length > this.#maxEvents) {
      this.#events = this.#events.slice(this.#events.length - this.#maxEvents);
    }
    this.#events = this.#events.filter((e) => e.t >= cutoff);
  }
}

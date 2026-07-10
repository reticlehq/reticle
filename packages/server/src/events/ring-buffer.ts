import { RING_BUFFER_DEFAULTS, type ReticleEvent } from '@reticlehq/core';

interface RingBufferOptions {
  maxEvents?: number;
  maxAgeMs?: number;
  maxBytes?: number;
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
  readonly #maxBytes: number;
  #events: ReticleEvent[] = [];
  #eventBytes: number[] = [];
  #totalBytes = 0;
  #droppedCount = 0;

  constructor(options: RingBufferOptions = {}) {
    this.#maxEvents = options.maxEvents ?? RING_BUFFER_DEFAULTS.MAX_EVENTS;
    this.#maxAgeMs = options.maxAgeMs ?? RING_BUFFER_DEFAULTS.MAX_AGE_MS;
    this.#maxBytes = options.maxBytes ?? RING_BUFFER_DEFAULTS.MAX_BYTES;
  }

  push(event: ReticleEvent, now: number): void {
    this.#events.push(event);
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.#eventBytes.push(bytes);
    this.#totalBytes += bytes;
    this.#evict(now);
  }

  /** Events at or after a given timestamp cursor. */
  since(cursor: number): ReticleEvent[] {
    return this.#events.slice(this.#lowerBound(cursor));
  }

  /** Events within the last `windowMs`, relative to `now`. */
  window(windowMs: number, now: number): ReticleEvent[] {
    return this.#events.slice(this.#lowerBound(now - windowMs));
  }

  #lowerBound(target: number): number {
    let lo = 0;
    let hi = this.#events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#events[mid]?.t ?? 0) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #evict(now: number): void {
    const before = this.#events.length;
    const cutoff = now - this.#maxAgeMs;
    while (
      this.#events.length > this.#maxEvents ||
      (this.#totalBytes > this.#maxBytes && this.#events.length > 0)
    ) {
      this.#events.shift();
      this.#totalBytes -= this.#eventBytes.shift() ?? 0;
    }
    while ((this.#events[0]?.t ?? cutoff) < cutoff) {
      this.#events.shift();
      this.#totalBytes -= this.#eventBytes.shift() ?? 0;
    }
    this.#droppedCount += before - this.#events.length;
  }

  /** Snapshot of buffer health for the agent — total events held and cumulative drops since connect. */
  bufferHealth(): { total: number; dropped: number } {
    return { total: this.#events.length, dropped: this.#droppedCount };
  }

  /** Reset the drop counter and return the count that was cleared (for per-observe accounting). */
  resetDropped(): number {
    const n = this.#droppedCount;
    this.#droppedCount = 0;
    return n;
  }
}

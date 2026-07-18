import { RING_BUFFER_DEFAULTS, type ReticleEvent } from '@reticlehq/core';

interface RingBufferOptions {
  maxEvents?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}

/**
 * Bounded, time-aware event store per session. The single data structure that powers
 * observe()/wait_for()/assert() — it lets us look both backward (recent buffer) and
 * forward (await new events).
 *
 * Eviction advances a HEAD index instead of shift()/splice() — O(1) per dropped event (was O(n) per
 * shift, i.e. O(n) per push at steady state under the DOM/animation floods). The dead prefix is
 * compacted away once it dominates, so the backing arrays stay bounded (amortized O(1)).
 *
 * `now` is injected so the buffer is deterministically testable (inject the clock, never call
 * Date.now() inside logic).
 */
export class RingBuffer {
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;
  readonly #maxBytes: number;
  #events: ReticleEvent[] = [];
  #eventBytes: number[] = [];
  /** Index of the first LIVE event; [0, #head) are evicted but not yet compacted out of the arrays. */
  #head = 0;
  #totalBytes = 0;
  #droppedCount = 0;

  constructor(options: RingBufferOptions = {}) {
    this.#maxEvents = options.maxEvents ?? RING_BUFFER_DEFAULTS.MAX_EVENTS;
    this.#maxAgeMs = options.maxAgeMs ?? RING_BUFFER_DEFAULTS.MAX_AGE_MS;
    this.#maxBytes = options.maxBytes ?? RING_BUFFER_DEFAULTS.MAX_BYTES;
  }

  #liveCount(): number {
    return this.#events.length - this.#head;
  }

  push(event: ReticleEvent, now: number, byteSize?: number): void {
    this.#events.push(event);
    // Prefer the size measured at the parse boundary (the raw wire frame the bridge already has) over
    // re-serializing here — a JSON.stringify per pushed event was the buffer's highest constant cost.
    const bytes = byteSize ?? Buffer.byteLength(JSON.stringify(event), 'utf8');
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

  /** Binary search over the LIVE window [#head, length) for the first event at/after `target`. */
  #lowerBound(target: number): number {
    let lo = this.#head;
    let hi = this.#events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#events[mid]?.t ?? 0) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #evict(now: number): void {
    const cutoff = now - this.#maxAgeMs;
    const before = this.#liveCount();
    // Drop from the head for cap, then bytes, then age — advancing #head is O(1) each (no shift).
    while (
      this.#liveCount() > this.#maxEvents ||
      (this.#totalBytes > this.#maxBytes && this.#liveCount() > 0)
    ) {
      this.#totalBytes -= this.#eventBytes[this.#head] ?? 0;
      this.#head += 1;
    }
    while (this.#liveCount() > 0 && (this.#events[this.#head]?.t ?? cutoff) < cutoff) {
      this.#totalBytes -= this.#eventBytes[this.#head] ?? 0;
      this.#head += 1;
    }
    this.#droppedCount += before - this.#liveCount();
    // Reclaim the dead prefix once it dominates the backing arrays (amortized O(1) compaction).
    if (this.#head > 1024 && this.#head * 2 >= this.#events.length) {
      this.#events = this.#events.slice(this.#head);
      this.#eventBytes = this.#eventBytes.slice(this.#head);
      this.#head = 0;
    }
  }

  /** Snapshot of buffer health for the agent — live events held and cumulative drops since connect. */
  bufferHealth(): { total: number; dropped: number } {
    return { total: this.#liveCount(), dropped: this.#droppedCount };
  }
}

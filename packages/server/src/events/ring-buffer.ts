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
    // Compute how many HEAD events to drop (cap, then bytes, then age), then splice ONCE. Shifting
    // per event re-indexed the whole array each time — O(k·n) for a k-event bulk age-eviction; one
    // splice is O(n). `remaining`/`bytes` track the post-drop state without mutating yet.
    let drop = 0;
    let bytes = this.#totalBytes;
    const total = this.#events.length;
    while (total - drop > this.#maxEvents || (bytes > this.#maxBytes && total - drop > 0)) {
      bytes -= this.#eventBytes[drop] ?? 0;
      drop += 1;
    }
    while (drop < total && (this.#events[drop]?.t ?? cutoff) < cutoff) {
      bytes -= this.#eventBytes[drop] ?? 0;
      drop += 1;
    }
    if (drop > 0) {
      this.#events.splice(0, drop);
      this.#eventBytes.splice(0, drop);
      this.#totalBytes = bytes;
    }
    this.#droppedCount += before - this.#events.length;
  }

  /** Snapshot of buffer health for the agent — total events held and cumulative drops since connect. */
  bufferHealth(): { total: number; dropped: number } {
    return { total: this.#events.length, dropped: this.#droppedCount };
  }
}

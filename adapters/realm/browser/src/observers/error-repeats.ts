/**
 * The same uncaught error, over and over, is one fact — not N events.
 *
 * An uncaught error inside the page is recorded as an event, and recording it can raise the same
 * error again, so the log becomes its own input. Reported from the field: a single repeating
 * `TypeError` wrote a session's `events.jsonl` to **685 GB at 13 MB/s for 14 hours**, until the
 * disk filled. The last 2 MB of that file are 100% `error.uncaught` carrying one identical stack
 * (#986).
 *
 * Nothing about that stream was informative after the first few occurrences. What a reader needs is
 * that the error happened, what it was, and that it is *still* happening — three facts, not
 * fourteen hours of duplicates.
 *
 * So: the first few occurrences of a fingerprint pass through untouched, and after that only
 * order-of-magnitude checkpoints do, each carrying the count it stands for. An error repeating
 * forever costs O(log n) events instead of O(n), and the shape of the output tells you it is a
 * runaway rather than a handful of unrelated failures.
 *
 * Deliberately NOT time-based. A rate limit measured in events per second still admits an unbounded
 * number of events over an unbounded session, which is exactly the fourteen-hour case; and it makes
 * the output depend on how fast the machine happens to be.
 */

import { fnv1a } from '@reticlehq/core';

/**
 * Occurrences of one fingerprint that pass through before suppression starts.
 *
 * Three rather than one: the first occurrence of an error and its first *repeat* are different
 * facts to a reader, and a burst leaves room to see a tight loop start without waiting for the
 * tenth.
 */
export const REPEAT_BURST = 3;

/**
 * Distinct fingerprints tracked at once.
 *
 * Bounded so the limiter cannot become the leak it exists to prevent: an app generating unique
 * error messages (a counter or a timestamp in the text) would otherwise grow this map without end.
 * At the cap the oldest entry is dropped, which at worst lets one fingerprint start its burst
 * again — a bounded cost, unlike an unbounded map.
 */
export const MAX_TRACKED_FINGERPRINTS = 256;

/** What the caller should do with this occurrence. */
export interface RepeatDecision {
  /** Emit it. */
  readonly emit: boolean;
  /**
   * How many occurrences this event stands for, present only on a checkpoint. An ordinary
   * first-few emission stands for itself and carries nothing.
   */
  readonly repeats?: number;
}

const PASS: RepeatDecision = { emit: true };
const DROP: RepeatDecision = { emit: false };

/** Is `count` a power of ten — 10, 100, 1000…? Those are the checkpoints. */
function isCheckpoint(count: number): boolean {
  if (count < 10) return false;
  let n = count;
  while (0 === n % 10) n /= 10;
  return 1 === n;
}

/**
 * The identity of an uncaught error, for repeat detection.
 *
 * Message, source, line and kind — the fields that make two occurrences the same defect. The stack
 * is included because two different call paths into one throwing function are genuinely two facts,
 * and it is already capped by the caller.
 */
export interface ErrorIdentity {
  readonly message: string;
  readonly source?: string;
  readonly line?: number;
  readonly kind?: string;
  readonly stack?: string;
}

export function fingerprintError(identity: ErrorIdentity): string {
  return fnv1a(
    [
      identity.message,
      identity.source ?? '',
      undefined === identity.line ? '' : String(identity.line),
      identity.kind ?? '',
      identity.stack ?? '',
    ].join('\x00'),
  );
}

export interface RepeatLimiter {
  /** Decide what to do with one occurrence. Call exactly once per occurrence. */
  admit(identity: ErrorIdentity): RepeatDecision;
}

export function createRepeatLimiter(
  burst: number = REPEAT_BURST,
  maxTracked: number = MAX_TRACKED_FINGERPRINTS,
): RepeatLimiter {
  // Insertion-ordered, and `admit` re-inserts on every occurrence, so the first key is the least
  // recently SEEN one. Eviction by recency is what keeps the entry worth keeping: a runaway error
  // is seen constantly, so it stays, while one-off fingerprints age out.
  const counts = new Map<string, number>();

  return {
    admit(identity) {
      const key = fingerprintError(identity);
      const seen = (counts.get(key) ?? 0) + 1;
      // Delete before set, always. A `Map` keeps a re-set key in its ORIGINAL position, so without
      // this the first fingerprint ever seen is also the first evicted -- and a runaway error is
      // exactly the one that was seen first. An app whose error text carries a counter would then
      // churn the runaway out and let it restart its burst, which is the case this bounds.
      counts.delete(key);
      if (counts.size >= maxTracked) {
        const oldest = counts.keys().next();
        if (!(oldest.done ?? false)) counts.delete(oldest.value);
      }
      counts.set(key, seen);

      if (seen <= burst) return PASS;
      return isCheckpoint(seen) ? { emit: true, repeats: seen } : DROP;
    },
  };
}

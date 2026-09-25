/**
 * One uncaught error repeating forever must cost a bounded number of events.
 *
 * The field report this exists for: a single repeating `TypeError` wrote a session's
 * `events.jsonl` to 685 GB at 13 MB/s over 14 hours and filled the disk. Recording an error can
 * raise the same error, so the path feeds itself (#986).
 */

import { describe, expect, it } from 'vitest';
import {
  createRepeatLimiter,
  fingerprintError,
  MAX_TRACKED_FINGERPRINTS,
  REPEAT_BURST,
  type ErrorIdentity,
} from './error-repeats.js';

const BOOM: ErrorIdentity = {
  message: "Cannot read properties of undefined (reading 'x')",
  source: 'https://app.test/src/main.tsx',
  line: 42,
  stack: 'TypeError: …\n  at render (main.tsx:42:7)',
};

/** How many of `count` occurrences of one identity are emitted. */
function emitted(count: number, identity: ErrorIdentity = BOOM): number {
  const limiter = createRepeatLimiter();
  let n = 0;
  for (let i = 0; i < count; i += 1) if (limiter.admit(identity).emit) n += 1;
  return n;
}

/** Explicit, because these loops run to a million admissions and a default timeout is a coin flip. */
const HEAVY_LOOP_TIMEOUT_MS = 30_000;

describe('a repeating uncaught error is one fact', () => {
  it('lets the first few through untouched', () => {
    const limiter = createRepeatLimiter();

    for (let i = 0; i < REPEAT_BURST; i += 1) {
      expect(limiter.admit(BOOM)).toEqual({ emit: true });
    }
  });

  it('suppresses the ones after the burst', () => {
    const limiter = createRepeatLimiter();
    for (let i = 0; i < REPEAT_BURST; i += 1) limiter.admit(BOOM);

    expect(limiter.admit(BOOM).emit).toBe(false);
  });

  it(
    'reports order-of-magnitude checkpoints, carrying the count they stand for',
    () => {
      const limiter = createRepeatLimiter();
      const checkpoints: number[] = [];
      for (let i = 0; i < 10_000; i += 1) {
        const decision = limiter.admit(BOOM);
        if (decision.repeats !== undefined) checkpoints.push(decision.repeats);
      }

      expect(checkpoints).toEqual([10, 100, 1000, 10_000]);
    },
    HEAVY_LOOP_TIMEOUT_MS,
  );

  it(
    'costs O(log n) events for an error that never stops',
    () => {
      // The shape that matters: an error that never stops is a handful of events, and the count
      // still grows with the runaway so a reader can see it is one.
      expect(emitted(10)).toBe(REPEAT_BURST + 1);
      expect(emitted(1_000_000)).toBe(REPEAT_BURST + 6);
    },
    HEAVY_LOOP_TIMEOUT_MS,
  );

  it(
    'does not suppress a first occurrence, however many others came before',
    () => {
      const limiter = createRepeatLimiter();
      for (let i = 0; i < 5000; i += 1) limiter.admit(BOOM);

      expect(limiter.admit({ ...BOOM, message: 'a different failure' })).toEqual({ emit: true });
    },
    HEAVY_LOOP_TIMEOUT_MS,
  );
});

describe('what counts as the same error', () => {
  it('separates two errors that differ in any identifying field', () => {
    const base = fingerprintError(BOOM);

    expect(fingerprintError({ ...BOOM, message: 'other' })).not.toBe(base);
    expect(fingerprintError({ ...BOOM, source: 'other.tsx' })).not.toBe(base);
    expect(fingerprintError({ ...BOOM, line: 43 })).not.toBe(base);
    expect(fingerprintError({ ...BOOM, kind: 'unhandledrejection' })).not.toBe(base);
    expect(fingerprintError({ ...BOOM, stack: 'a different call path' })).not.toBe(base);
  });

  it('is stable for the same error', () => {
    expect(fingerprintError(BOOM)).toBe(fingerprintError({ ...BOOM }));
  });

  it('does not collide across field boundaries', () => {
    // Joining without a separator would make these two the same error.
    expect(fingerprintError({ message: 'ab', source: 'c' })).not.toBe(
      fingerprintError({ message: 'a', source: 'bc' }),
    );
  });
});

describe('the limiter cannot become the leak it prevents', () => {
  it('tracks a bounded number of fingerprints', () => {
    const limiter = createRepeatLimiter();

    // An app whose error text carries a counter produces a new fingerprint every time. Nothing
    // here should grow without end; the only observable is that it keeps answering.
    for (let i = 0; i < MAX_TRACKED_FINGERPRINTS * 4; i += 1) {
      expect(limiter.admit({ message: `failure #${String(i)}` }).emit).toBe(true);
    }
  });

  it('keeps counting a runaway while unique errors churn past it', () => {
    // Eviction is by RECENCY, and a runaway is seen constantly, so it survives the churn rather
    // than being evicted as the oldest entry and restarting its burst. Without that, this is the
    // shape that defeats the limiter: an app whose error text carries a counter pushes the one
    // error that matters out of the map on every iteration.
    const limiter = createRepeatLimiter();
    let emittedBoom = 0;
    for (let i = 0; i < 2000; i += 1) {
      limiter.admit({ message: `unique ${String(i)}` });
      if (limiter.admit(BOOM).emit) emittedBoom += 1;
    }

    // Unbroken counting: burst, then 10/100/1000. An evicted-and-restarted runaway emits its
    // burst again and again, which is hundreds.
    expect(emittedBoom).toBe(REPEAT_BURST + 3);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from './clock.js';
import { requireCapturedMethod } from '../util/captured-method.js';

afterEach(() => {
  resetClock();
});

describe('fake clock', () => {
  it('freezes setTimeout and fires it only when advanced past the delay', () => {
    freezeClock();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 5000);
    advanceClock(4999);
    expect(fired).toBe(false);
    advanceClock(2);
    expect(fired).toBe(true);
  });

  it('freezes Date.now / performance.now and advances them deterministically', () => {
    freezeClock();
    const t0 = Date.now();
    advanceClock(1000);
    expect(Date.now() - t0).toBe(1000);
  });

  it('runs intervals each tick', () => {
    freezeClock();
    let n = 0;
    const id = setInterval(() => {
      n += 1;
    }, 100);
    advanceClock(350);
    expect(n).toBe(3);
    // clearInterval must STOP it — even though the interval has already fired (and internally
    // rescheduled) several times. The app holds the id from setInterval; that id must keep working.
    clearInterval(id);
    advanceClock(1000);
    expect(n).toBe(3); // no further ticks after the clear
  });

  it('reset restores real timers', () => {
    freezeClock();
    expect(isClockFrozen()).toBe(true);
    resetClock();
    expect(isClockFrozen()).toBe(false);
  });
});

/**
 * Restoring real timers is only half of un-freezing. The callbacks the app queued during the freeze
 * live in the virtual queue, and discarding them leaves the app broken in a NEW way — a toast that
 * never dismisses, a retry that never fires — while `Date.now()` and future timers look healthy, so
 * nothing points at the cause. This matters most on the path resetClock is actually called from: the
 * agent froze the clock, the bridge died, and nobody un-froze it deliberately.
 */
describe('resetClock hands back the work queued while frozen', () => {
  afterEach(() => {
    resetClock();
  });

  it('runs a timeout that was scheduled during the freeze', async () => {
    freezeClock();
    let fired = false;
    window.setTimeout(() => {
      fired = true;
    }, 5);
    resetClock(); // bridge lost — nothing will ever advance the virtual clock again
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(true);
  });

  it('preserves the REMAINING delay rather than firing everything immediately', async () => {
    freezeClock();
    let fired = false;
    window.setTimeout(() => {
      fired = true;
    }, 10_000);
    resetClock();
    await new Promise((r) => setTimeout(r, 30));
    // A 10s timer must still be pending — re-arming must not collapse into "run it all now".
    expect(fired).toBe(false);
  });

  it('resumes an interval AND lets the app cancel it with the id it was given', async () => {
    // The handle is the whole difficulty: the app holds a VIRTUAL id, the re-arm produces a NATIVE one.
    // Two earlier attempts got this wrong — one re-armed without translation (uncancellable, and the
    // stale clear could kill an unrelated timer), the other dropped intervals entirely to dodge it
    // while re-arming timeouts, which has the identical hazard.
    freezeClock();
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
    }, 5);
    resetClock();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toBeGreaterThan(0); // it resumed
    const seen = ticks;
    clearInterval(id); // the app's own cleanup, with the id it was handed while frozen
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toBe(seen); // and it actually stopped
  });

  it('lets the app cancel a re-armed TIMEOUT with its original id', async () => {
    // `const t = setTimeout(hide, 5000); return () => clearTimeout(t)` — the standard effect cleanup.
    freezeClock();
    let fired = false;
    const id = window.setTimeout(() => {
      fired = true;
    }, 10);
    resetClock();
    clearTimeout(id);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
  });

  it('does not disturb a native timer that happens to share the virtual id space', async () => {
    // Both id spaces start at 1, so a naive re-arm made the app's clear cancel an unrelated timer.
    freezeClock();
    window.setTimeout(() => undefined, 10_000); // virtual id 1
    resetClock();
    let unrelated = false;
    const nativeId = setTimeout(() => {
      unrelated = true;
    }, 20);
    clearTimeout(1 as unknown as typeof nativeId); // stale virtual id from the frozen period
    await new Promise((r) => setTimeout(r, 50));
    expect(unrelated).toBe(true); // the unrelated timer must survive
    clearTimeout(nativeId);
  });
});

/**
 * The timer natives must be invoked with `this === window`.
 *
 * jsdom does not care what `this` is, so every test above passes while the REAL browser throws
 * `TypeError: Illegal invocation` — `window.setTimeout` captured into a plain object and called as
 * `originals.setTimeout(...)` arrives with `this === originals`, which the DOM rejects. The whole
 * re-arm path is guarded by an early return when nothing is pending, so it only fires when the app
 * actually queued work during the freeze — the exact case resetClock exists to serve, and the one no
 * jsdom test could see. Found by `bench/harness/clock-timetravel.mjs` against a real Chromium.
 *
 * These tests give jsdom the browser's opinion: a native that refuses a foreign `this`.
 */
describe('the timer natives are called with the right receiver (real-DOM contract)', () => {
  /** Swap in natives that enforce `this === window`, the way a real browser does. */
  function installStrictNatives(): () => void {
    // Stored values, so this double restores the same function objects the environment had.
    const raw = {
      setTimeout: requireCapturedMethod<typeof window.setTimeout>(window, 'setTimeout'),
      clearTimeout: requireCapturedMethod<typeof window.clearTimeout>(window, 'clearTimeout'),
      setInterval: requireCapturedMethod<typeof window.setInterval>(window, 'setInterval'),
      clearInterval: requireCapturedMethod<typeof window.clearInterval>(window, 'clearInterval'),
    };
    // Faithful to WebIDL, which is the point — an over-strict double would fail the bare
    // `setTimeout(fn, ms)` call that every browser accepts. Only a FOREIGN receiver is illegal:
    // `undefined`/`null` resolves to the global (a plain call in a module), `window` is the method
    // call. `{...}.setTimeout(fn)` is the one that throws, and it is the one this pins.
    const strict = <T extends (...args: never[]) => unknown>(fn: T) =>
      function (this: unknown, ...args: never[]): unknown {
        const receiverOk = this === undefined || null === this || this === window;
        if (!receiverOk) throw new TypeError('Illegal invocation');
        return (fn as (...a: never[]) => unknown).apply(window, args);
      };
    window.setTimeout = strict(raw.setTimeout) as unknown as typeof window.setTimeout;
    window.clearTimeout = strict(raw.clearTimeout) as unknown as typeof window.clearTimeout;
    window.setInterval = strict(raw.setInterval) as unknown as typeof window.setInterval;
    window.clearInterval = strict(raw.clearInterval) as unknown as typeof window.clearInterval;
    return () => {
      window.setTimeout = raw.setTimeout;
      window.clearTimeout = raw.clearTimeout;
      window.setInterval = raw.setInterval;
      window.clearInterval = raw.clearInterval;
    };
  }

  it('re-arms a pending TIMEOUT without an Illegal invocation', async () => {
    const restore = installStrictNatives();
    try {
      freezeClock();
      let fired = false;
      window.setTimeout(() => {
        fired = true;
      }, 5);
      expect(() => {
        resetClock();
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 40));
      expect(fired).toBe(true);
    } finally {
      resetClock();
      restore();
    }
  });

  it('re-arms a pending INTERVAL without an Illegal invocation', async () => {
    const restore = installStrictNatives();
    try {
      freezeClock();
      let ticks = 0;
      const id = window.setInterval(() => {
        ticks += 1;
      }, 5);
      expect(() => {
        resetClock();
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 30));
      expect(ticks).toBeGreaterThan(0);
      clearInterval(id);
    } finally {
      resetClock();
      restore();
    }
  });

  it('translates a clear() through the shim without an Illegal invocation', async () => {
    // The shim calls the raw clear as a bare reference too, so it has the identical defect.
    const restore = installStrictNatives();
    try {
      freezeClock();
      let fired = false;
      const id = window.setTimeout(() => {
        fired = true;
      }, 10);
      resetClock();
      expect(() => {
        clearTimeout(id);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 40));
      expect(fired).toBe(false);
    } finally {
      resetClock();
      restore();
    }
  });
});

/**
 * The three ways a frozen clock could hurt the page it is installed in.
 *
 *   1. It DROPPED the trailing arguments of `setTimeout(cb, ms, a, b)`. Real timers forward them, so
 *      every callback written against that form saw `undefined` for the whole freeze.
 *   2. It restored the timer slots unconditionally, uninstalling anything that wrapped them after us.
 *   3. It had no deadman. An agent that freezes the clock and then goes quiet on a still-open socket
 *      left the customer's page with time stopped indefinitely: every debounce, throttle, poll and
 *      auto-dismiss dead, and nothing on screen saying why.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  freezeClock,
  advanceClock,
  resetClock,
  isClockFrozen,
  FREEZE_WATCHDOG_MS,
} from './clock.js';
import { captureMethod } from '../patching/capture-method.js';

type SlotMap = Record<string, (...args: unknown[]) => unknown>;
const slots = window as unknown as SlotMap;

afterEach(() => {
  resetClock();
});

/** Stand in for the page's real timers so the watchdog's arming is observable, not timed. */
function recordNativeTimers(): {
  armed: Array<{ cb: () => void; delay: unknown }>;
  cleared: unknown[];
  restore: () => void;
} {
  const realSetTimeout = captureMethod(slots, 'setTimeout');
  const realClearTimeout = captureMethod(slots, 'clearTimeout');
  const armed: Array<{ cb: () => void; delay: unknown }> = [];
  const cleared: unknown[] = [];
  let id = 0;
  slots['setTimeout'] = (cb: unknown, delay: unknown): number => {
    armed.push({ cb: cb as () => void, delay });
    id += 1;
    return id;
  };
  slots['clearTimeout'] = (handle: unknown): void => {
    cleared.push(handle);
  };
  return {
    armed,
    cleared,
    restore: () => {
      slots['setTimeout'] = realSetTimeout;
      slots['clearTimeout'] = realClearTimeout;
    },
  };
}

describe('frozen setTimeout keeps the real signature', () => {
  it('forwards the trailing arguments to the callback', () => {
    freezeClock();
    let seen: unknown[] = [];
    setTimeout(
      (...args: unknown[]) => {
        seen = args;
      },
      10,
      'order-42',
      7,
    );
    advanceClock(20);
    expect(seen).toEqual(['order-42', 7]);
  });

  it('forwards the trailing arguments on every interval tick', () => {
    freezeClock();
    const seen: unknown[][] = [];
    const id = setInterval(
      (...args: unknown[]) => {
        seen.push(args);
      },
      100,
      'tick',
    );
    advanceClock(250);
    clearInterval(id);
    expect(seen).toEqual([['tick'], ['tick']]);
  });
});

describe('the frozen clock is restored by a watchdog', () => {
  it('arms a real timer at the bound and restores real time when it fires', () => {
    const native = recordNativeTimers();
    try {
      freezeClock();
      expect(isClockFrozen()).toBe(true);
      const watchdog = native.armed.at(-1);
      expect(watchdog?.delay).toBe(FREEZE_WATCHDOG_MS);

      watchdog?.cb();

      expect(isClockFrozen()).toBe(false);
    } finally {
      resetClock();
      native.restore();
    }
  });

  it('is refreshed by the agent advancing the clock', () => {
    const native = recordNativeTimers();
    try {
      freezeClock();
      const armedAfterFreeze = native.armed.length;
      advanceClock(1000);
      expect(native.armed.length).toBe(armedAfterFreeze + 1);
      expect(native.cleared).toHaveLength(1);
      expect(native.armed.at(-1)?.delay).toBe(FREEZE_WATCHDOG_MS);
    } finally {
      resetClock();
      native.restore();
    }
  });
});

describe('resetClock leaves a later wrapper alone', () => {
  it('restores only the slots that still hold our fake', () => {
    const realSetTimeout = captureMethod(slots, 'setTimeout');
    try {
      freezeClock();
      const ourSetTimeout = captureMethod(slots, 'setTimeout');
      const theirs = (...args: unknown[]): unknown => ourSetTimeout(...args);
      slots['setTimeout'] = theirs;

      resetClock();

      expect(captureMethod(slots, 'setTimeout')).toBe(theirs);
      // Everything else was still ours, so it went back to the page's real implementation.
      expect(isClockFrozen()).toBe(false);
    } finally {
      slots['setTimeout'] = realSetTimeout;
    }
  });
});

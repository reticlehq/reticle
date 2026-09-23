import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installScroll } from './scroll.js';
import type { Teardown } from './types.js';

/**
 * Two readings of the PAGE clock, far enough apart to be one scroll gesture and no more.
 *
 * `installScroll` throttles on `performance.now()` from a `lastEmit` of 0, so "has the throttle
 * window passed?" is really "does the page clock already read more than the window?". That is true
 * by accident whenever the clock's origin is the node process's start, and this suite relied on it
 * without saying so: under the globals-copy worker `performance` was Node's, and a probe read it at
 * 2,304ms by the time a test ran. This package now runs in the jsdom VM context so synthetic input
 * can carry a real `Window` (see `vitest.config.ts`), and there the origin is the window's own
 * creation — the same probe read 358ms, and a file that starts faster than the throttle window reads
 * less than it. The leading emit was then deferred and the first assertion below read `undefined`.
 *
 * So the clock is stated rather than inherited. These are not durations being asserted: the first
 * value only has to be past the throttle window, the second only has to be inside it, and the
 * trailing emit is still awaited on the real clock by the poll further down.
 */
const CLOCK_SETTLED_MS = 1_000;
const CLOCK_MID_GESTURE_MS = 1_010;

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

function setScrollY(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

describe('installScroll — trailing edge captures the resting position', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
    setScrollY(0);
    vi.restoreAllMocks();
  });

  it('emits the FINAL resting position after scrolling stops, not just the leading sample', async () => {
    const events: Captured[] = [];
    const pageClock = vi.spyOn(performance, 'now');
    pageClock.mockReturnValue(CLOCK_SETTLED_MS);
    teardown = installScroll((type, data) => events.push({ type, data }));

    setScrollY(100);
    window.dispatchEvent(new Event('scroll')); // leading-edge emit at y=100
    pageClock.mockReturnValue(CLOCK_MID_GESTURE_MS);
    setScrollY(500);
    window.dispatchEvent(new Event('scroll')); // within the throttle window → schedules a trailing emit
    // Hand the trailing timer back the real clock — it is a real `setTimeout`, and the poll below
    // waits for it on the same clock the observer will stamp the resting position with.
    pageClock.mockRestore();

    const positions = (): Captured[] => events.filter((e) => e.type === EventType.SCROLL_POSITION);
    expect(positions().at(-1)?.data['y']).toBe(100); // only the leading sample so far

    // Poll for the trailing emit rather than sleeping past it. A fixed `setTimeout(160)` is a
    // statement about the MACHINE: it passed alone and failed inside the full unit gate, where the
    // trailing timer competes with every other suite for the event loop. The invariant is that the
    // resting position eventually arrives, not that it arrives within 160ms — see the note on
    // timing assertions in CLAUDE.md.
    const deadline = Date.now() + 5000;
    while (positions().at(-1)?.data['y'] !== 500 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The resting position (500) must be reported — a leading-only throttle dropped it entirely.
    expect(positions().at(-1)?.data['y']).toBe(500);
  });

  it('teardown removes the scroll listener', () => {
    const events: Captured[] = [];
    const td = installScroll((type, data) => events.push({ type, data }));
    td();
    events.length = 0;

    setScrollY(200);
    window.dispatchEvent(new Event('scroll'));
    expect(events.filter((e) => e.type === EventType.SCROLL_POSITION)).toHaveLength(0);
  });
});

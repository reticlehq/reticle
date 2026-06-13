import { describe, it, expect, afterEach } from 'vitest';
import { freezeClock, advanceClock, resetClock, isClockFrozen } from './clock.js';

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
    clearInterval(id);
  });

  it('reset restores real timers', () => {
    freezeClock();
    expect(isClockFrozen()).toBe(true);
    resetClock();
    expect(isClockFrozen()).toBe(false);
  });
});

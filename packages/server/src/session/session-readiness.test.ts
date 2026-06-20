import { describe, expect, it } from 'vitest';
import { waitForReady } from './session-readiness.js';

describe('waitForReady', () => {
  it('returns true immediately when a session is already connected (no sleep, no latency)', async () => {
    let slept = 0;
    const ready = await waitForReady({
      count: () => 1,
      timeoutMs: 5000,
      now: () => 0,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });
    expect(ready).toBe(true);
    expect(slept).toBe(0);
  });

  it('resolves true once a session appears mid-wait', async () => {
    let n = 0;
    let clock = 0;
    const ready = await waitForReady({
      count: () => (n >= 2 ? 1 : 0), // connects on the 2nd poll
      timeoutMs: 5000,
      now: () => clock,
      sleep: (ms) => {
        n += 1;
        clock += ms;
        return Promise.resolve();
      },
      pollMs: 50,
    });
    expect(ready).toBe(true);
    expect(n).toBe(2);
  });

  it('returns false when the timeout elapses with no session', async () => {
    let clock = 0;
    const ready = await waitForReady({
      count: () => 0,
      timeoutMs: 300,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      pollMs: 100,
    });
    expect(ready).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(300);
  });
});

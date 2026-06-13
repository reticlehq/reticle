import { describe, it, expect, vi } from 'vitest';
import { nativeSetInterval } from './native-timers.js';

describe('nativeSetInterval', () => {
  it('stops firing after the returned stopper is called', async () => {
    const cb = vi.fn();
    const stop = nativeSetInterval(cb, 5);
    stop(); // stop before the first tick
    await new Promise((r) => setTimeout(r, 30));
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires repeatedly until stopped', async () => {
    const cb = vi.fn();
    const stop = nativeSetInterval(cb, 5);
    await new Promise((r) => setTimeout(r, 30));
    stop();
    const count = cb.mock.calls.length;
    expect(count).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(cb.mock.calls.length).toBe(count); // no more after stop
  });
});

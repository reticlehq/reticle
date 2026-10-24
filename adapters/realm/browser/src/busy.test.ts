/** Work the app declares is announced as it starts and as it ends, whether it resolves or rejects. */
import { describe, expect, it } from 'vitest';
import { RETICLE_BUSY_SIGNAL } from '@reticlehq/core';
import { trackBusy, trackShortTimers } from './busy.js';

describe('trackBusy', () => {
  it('signals a start, then an end when the work settles either way, and hands the work back', async () => {
    const sent: unknown[] = [];
    const signal = (name: string, data: Record<string, unknown>): void => {
      sent.push([name, data]);
    };
    expect(await trackBusy(Promise.resolve(7), signal)).toBe(7);
    await expect(trackBusy(Promise.reject(new Error('no')), signal)).rejects.toThrow('no');
    expect(sent).toEqual([
      [RETICLE_BUSY_SIGNAL, { delta: 1 }],
      [RETICLE_BUSY_SIGNAL, { delta: -1 }],
      [RETICLE_BUSY_SIGNAL, { delta: 1 }],
      [RETICLE_BUSY_SIGNAL, { delta: -1 }],
    ]);
  });
});

/**
 * Opt-in: short timers are work the app scheduled (a debounce, a retry), and a settle waits for them.
 * Off unless asked: patching every app's setTimeout costs every app.
 */
describe('trackShortTimers', () => {
  it('counts a short timer busy until it fires or is cleared, and leaves long ones alone', async () => {
    const deltas: number[] = [];
    const undo = trackShortTimers((_name, data) => {
      deltas.push(data['delta'] as number);
    }, 50);
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      const cleared = setTimeout(() => undefined, 10);
      clearTimeout(cleared);
      const long = setTimeout(() => undefined, 5000);
      clearTimeout(long);
    } finally {
      undo();
    }
    expect(deltas).toEqual([1, -1, 1, -1]);
  });
});

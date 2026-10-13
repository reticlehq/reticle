import { describe, expect, it } from 'vitest';
import { waitForServedChange } from './inject.mjs';

/**
 * The observation retry reverts a regression with `git checkout` and re-injects it within
 * milliseconds. On Linux the dev server's watcher kept the reverted copy: the file on disk had
 * `fault-timeout`, Vite served the module without it, and network-timeout/playwright was recorded
 * NOT MEASURED on most bench runs on main. A browser opened next loads what Vite SERVES, so the
 * harness now waits for the served module to change, and re-saves the file when the watcher missed it.
 */

function rig(servedSeq) {
  const nudges = [];
  let now = 0;
  const opts = {
    timeoutMs: 1000,
    nudgeMs: 300,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  let i = 0;
  const read = async () => servedSeq[Math.min(i++, servedSeq.length - 1)];
  const nudge = () => nudges.push(now);
  return { read, nudge, nudges, opts };
}

describe('waitForServedChange', () => {
  it('returns as soon as the served module differs', async () => {
    const r = rig(['old', 'old', 'new']);
    await waitForServedChange(r.read, 'old', r.nudge, r.opts);
    expect(r.nudges).toEqual([]);
  });

  it('re-saves the file when the watcher missed the edit, then sees the change', async () => {
    const r = rig([...Array(10).fill('old'), 'new']);
    await waitForServedChange(r.read, 'old', r.nudge, r.opts);
    expect(r.nudges.length).toBeGreaterThan(0);
  });

  it('fails, naming the cause, when the module never changes', async () => {
    const r = rig(['old']);
    await expect(waitForServedChange(r.read, 'old', r.nudge, r.opts)).rejects.toThrow(
      /still serves/,
    );
  });

  it('ignores the HMR timestamp Vite adds to imports', async () => {
    const r = rig(['load("/src/a.tsx?t=2")', 'new']);
    await waitForServedChange(r.read, 'load("/src/a.tsx?t=1")', r.nudge, r.opts);
    expect(r.nudges).toEqual([]);
  });
});

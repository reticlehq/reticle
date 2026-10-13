/**
 * A Harness wait re-checks from a page-event listener and a timer, outside the awaited chain. Those
 * re-checks went to the page untagged, and the HUD filed the Harness's "Finding…" rows in the Agent
 * Log. A callback bound inside a drive is still the drive's when it fires.
 */
import { describe, expect, it } from 'vitest';
import { bindDrivenBy, currentDrivenBy, runDrivenBy } from './driven-by.js';
import { keepCallerContextInDaemon } from '@/portal/session/daemon-answers.js';

const later = (fn: () => void): Promise<void> =>
  new Promise((resolve) => {
    // A fresh macrotask from outside any drive, as a page message would arrive.
    setImmediate(() => {
      fn();
      resolve();
    });
  });

describe('a callback bound inside a Harness drive', () => {
  it('is still the drive when it fires outside the awaited chain', async () => {
    let seen: unknown = 'unset';
    let bound: (() => void) | undefined;
    await runDrivenBy({ harness: 'h1', driver: 'jev' }, () => {
      bound = bindDrivenBy(() => (seen = currentDrivenBy()?.harness));
      return Promise.resolve();
    });
    await later(() => bound?.());
    expect(seen).toBe('h1');
  });

  it("is what the engine's re-checks use, and is a no-op for the agent's own calls", async () => {
    let seen: unknown = 'unset';
    const agents = keepCallerContextInDaemon(() => (seen = currentDrivenBy()));
    await later(agents);
    expect(seen).toBeUndefined();
    let harness: (() => void) | undefined;
    await runDrivenBy({ harness: 'h2', driver: 'jev' }, () => {
      harness = keepCallerContextInDaemon(() => (seen = currentDrivenBy()?.harness));
      return Promise.resolve();
    });
    await later(() => harness?.());
    expect(seen).toBe('h2');
  });
});

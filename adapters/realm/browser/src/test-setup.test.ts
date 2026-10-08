/**
 * The package's own test setup runs, alongside the shared one.
 *
 * Incident: the shared options gained `setupFiles` (a temporary HOME for every package), and this
 * package spread them AFTER its own `setupFiles`, so the later key replaced it. `vitest.setup.ts`
 * stopped running: every storage-touching test ran on jsdom's Storage instead of the MockStorage
 * it was written against, and all of them still passed.
 */
import { describe, expect, it } from 'vitest';

describe('the browser package test environment', () => {
  it('installs its own MockStorage', () => {
    expect(globalThis.localStorage.constructor.name).toBe('MockStorage');
  });
});

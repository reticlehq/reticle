import { describe, it, expect, vi } from 'vitest';
import { createHydrationTracker } from './hydration.js';

describe('createHydrationTracker', () => {
  it('fires onHydrated exactly once, on the first commit', () => {
    const onHydrated = vi.fn();
    const tracker = createHydrationTracker(onHydrated);
    expect(tracker.isHydrated()).toBe(false);

    tracker.onCommit();
    tracker.onCommit();
    tracker.onCommit();

    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(tracker.isHydrated()).toBe(true);
  });

  it('never fires when no commit happens (pre-hydration stays false)', () => {
    const onHydrated = vi.fn();
    const tracker = createHydrationTracker(onHydrated);
    expect(onHydrated).not.toHaveBeenCalled();
    expect(tracker.isHydrated()).toBe(false);
  });
});

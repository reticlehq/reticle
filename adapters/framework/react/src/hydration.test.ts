import { describe, it, expect, vi } from 'vitest';
import { createHydrationTracker } from './hydration.js';
import { HydrationState } from './hydration-state.js';

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

  // #1654: Next commits the shell, and a Suspense boundary under it hydrates seconds later.
  it('does not fire on a commit while a server-rendered part is still dehydrated', () => {
    const onHydrated = vi.fn();
    let state: HydrationState = HydrationState.PENDING;
    const tracker = createHydrationTracker(onHydrated, () => state);

    tracker.onCommit();
    expect(onHydrated).not.toHaveBeenCalled();
    expect(tracker.isHydrated()).toBe(false);

    state = HydrationState.DONE;
    tracker.onCommit();
    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(tracker.isHydrated()).toBe(true);
  });

  // #1654: Next installs the adapter in a useEffect, after the page hydrated. No commit comes after
  // that on a quiet page, so the signal never fired and a wait for it ran to its bound.
  it('fires at install when React already hydrated the page', () => {
    const onHydrated = vi.fn();
    const tracker = createHydrationTracker(onHydrated, () => HydrationState.DONE);

    tracker.onInstall();

    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(tracker.isHydrated()).toBe(true);
  });

  it('does not fire at install before React rendered, or while a part is dehydrated', () => {
    const onHydrated = vi.fn();
    for (const state of [HydrationState.NONE, HydrationState.PENDING]) {
      createHydrationTracker(onHydrated, () => state).onInstall();
    }
    expect(onHydrated).not.toHaveBeenCalled();
  });
});

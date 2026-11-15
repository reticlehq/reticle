import { describe, it, expect, vi } from 'vitest';
import { HydrationState } from '@reticlehq/core';
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
    expect(tracker.state()).toBe(HydrationState.DONE);
  });

  it('never fires when no commit happens (pre-hydration stays false)', () => {
    const onHydrated = vi.fn();
    const tracker = createHydrationTracker(onHydrated);
    tracker.onInstall();
    expect(onHydrated).not.toHaveBeenCalled();
    expect(tracker.isHydrated()).toBe(false);
    expect(tracker.state()).toBe(HydrationState.NONE);
  });

  // #1654: Next commits the shell, and a Suspense boundary under it hydrates seconds later.
  it('does not fire on a commit while a server-rendered part is still dehydrated', () => {
    const onHydrated = vi.fn();
    let state: HydrationState = HydrationState.PENDING;
    const tracker = createHydrationTracker(onHydrated, () => state);

    tracker.onCommit();
    expect(onHydrated).not.toHaveBeenCalled();
    expect(tracker.isHydrated()).toBe(false);
    expect(tracker.state()).toBe(HydrationState.PENDING);

    state = HydrationState.DONE;
    tracker.onCommit();
    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(tracker.isHydrated()).toBe(true);
  });

  // A commit that the page read could not place (no root found, or a tree too large to read to the
  // end) is not proof of hydration. The signal used to fire on any state that was not PENDING.
  it('does not fire on a commit when the read says NONE or UNKNOWN', () => {
    const onHydrated = vi.fn();
    for (const state of [HydrationState.NONE, HydrationState.UNKNOWN]) {
      createHydrationTracker(onHydrated, () => state).onCommit();
    }
    expect(onHydrated).not.toHaveBeenCalled();
  });

  it('stops reading the page on commits once a read could not reach the end of the tree', () => {
    const onHydrated = vi.fn();
    const read = vi.fn<() => HydrationState>(() => HydrationState.UNKNOWN);
    const tracker = createHydrationTracker(onHydrated, read);

    tracker.onCommit();
    tracker.onCommit();
    tracker.onCommit();

    expect(read).toHaveBeenCalledTimes(1);
    expect(tracker.state()).toBe(HydrationState.UNKNOWN);
    expect(onHydrated).not.toHaveBeenCalled();
  });

  // #2269 review: every commit pushed its root, also after the answer was fixed, so a long session
  // kept every root React ever committed.
  it('reads and keeps no root once the page is hydrated or unreadable', () => {
    for (const final of [HydrationState.DONE, HydrationState.UNKNOWN]) {
      let kept: readonly unknown[] = [];
      let reads = 0;
      const tracker = createHydrationTracker(vi.fn(), (roots) => {
        kept = roots;
        reads += 1;
        return final;
      });
      tracker.onCommit({ current: {} });
      tracker.onCommit({ current: {} });
      tracker.onCommit({ current: {} });

      // One read, at the first commit. After it the tracker holds no root at all.
      expect(reads).toBe(1);
      expect(kept).toHaveLength(0);
    }
  });

  it('gives the read every root that a commit named', () => {
    const seen: unknown[][] = [];
    const first = { current: {} };
    const second = { current: {} };
    const tracker = createHydrationTracker(vi.fn(), (roots) => {
      seen.push([...roots]);
      return HydrationState.PENDING;
    });

    tracker.onCommit(first);
    tracker.onCommit(second);
    tracker.onCommit(first);

    expect(seen.at(-1)).toEqual([first, second]);
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

  it('does not fire at install before React rendered, while a part is dehydrated, or when unsure', () => {
    const onHydrated = vi.fn();
    for (const state of [HydrationState.NONE, HydrationState.PENDING, HydrationState.UNKNOWN]) {
      createHydrationTracker(onHydrated, () => state).onInstall();
    }
    expect(onHydrated).not.toHaveBeenCalled();
  });

  it('reads the page again for its state until it is hydrated, and not after', () => {
    const read = vi.fn<() => HydrationState>(() => HydrationState.NONE);
    const tracker = createHydrationTracker(vi.fn(), read);

    expect(tracker.state()).toBe(HydrationState.NONE);
    read.mockReturnValue(HydrationState.DONE);
    tracker.onCommit();
    const reads = read.mock.calls.length;

    expect(tracker.state()).toBe(HydrationState.DONE);
    expect(read.mock.calls.length).toBe(reads);
  });
});

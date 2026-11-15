/**
 * React hydration detection — a science-backed differentiator. The published literature says no agent
 * framework can detect hydration completion from OUTSIDE the page: pre-hydration clicks are silent no-ops,
 * and only an in-app SDK knows when handlers attached. We emit a `reticle:hydration-complete` signal
 * exactly once, letting the agent wait for interactivity instead of clicking into the void. Pure
 * tracker; the commit hook drives it, the SDK emits the signal.
 *
 * With a page read, the signal fires on the first commit after which the read says DONE, or at
 * install when React hydrated the page before the adapter loaded (#1654). Next installs the adapter in
 * a `useEffect`, after the shell committed: a signal that waited for the next commit never came on a
 * quiet page, and one that fired on any commit came before a slow Suspense boundary had handlers.
 * NONE, PENDING and UNKNOWN all hold the signal back: none of them says that the page is hydrated.
 */

import { HydrationState, RETICLE_HYDRATION_SIGNAL } from '@reticlehq/core';

/** The signal fired once React has hydrated the page (handlers attached). */
export const HYDRATION_COMPLETE_SIGNAL = RETICLE_HYDRATION_SIGNAL;

/** Reads the page's hydration state. `roots` are the FiberRoots that commits named so far. */
export type HydrationRead = (roots: readonly unknown[]) => HydrationState;

export interface HydrationTracker {
  /**
   * Call on every React commit, with the FiberRoot that committed when the hook gives one. Fires
   * `onHydrated` once, when the page is hydrated.
   */
  onCommit(root?: unknown): void;
  /** Call once at install. Fires `onHydrated` when React already hydrated the whole page. */
  onInstall(): void;
  isHydrated(): boolean;
  /** DONE once hydrated. Before that, what the page read says now (NONE with no read). */
  state(): HydrationState;
}

/**
 * @param read The page's hydration state. Without one, the tracker cannot read the page: it fires on
 *   the first commit, as it did before #1654, and `onInstall` does nothing.
 */
export function createHydrationTracker(
  onHydrated: () => void,
  read?: HydrationRead,
): HydrationTracker {
  let hydrated = false;
  /*
   * Set when a read could not reach the end of the tree (too large, or a shape this adapter does not
   * know). Such a page stays so, and a walk of up to `MAX_HYDRATION_WALK` fibers on each of its
   * commits would cost the app for nothing. So the tracker stops reading, and says UNKNOWN.
   */
  let unreadable = false;
  const roots: unknown[] = [];
  const settle = (): void => {
    if (hydrated || unreadable) {
      return;
    }
    if (read !== undefined) {
      const now = read(roots);
      unreadable = HydrationState.UNKNOWN === now;
      if (HydrationState.DONE !== now) {
        return;
      }
    }
    hydrated = true;
    onHydrated();
  };
  return {
    onCommit: (root?: unknown): void => {
      if (null !== root && 'object' === typeof root && !roots.includes(root)) {
        roots.push(root);
      }
      settle();
    },
    onInstall: (): void => {
      if (read !== undefined) {
        settle();
      }
    },
    isHydrated: (): boolean => hydrated,
    state: (): HydrationState => {
      if (hydrated) {
        return HydrationState.DONE;
      }
      if (unreadable) {
        return HydrationState.UNKNOWN;
      }
      return read === undefined ? HydrationState.NONE : read(roots);
    },
  };
}

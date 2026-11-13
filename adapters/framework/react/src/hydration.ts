/**
 * React hydration detection — a science-backed differentiator. The published literature says no agent
 * framework can detect hydration completion from OUTSIDE the page: pre-hydration clicks are silent no-ops,
 * and only an in-app SDK knows when handlers attached. We emit a `reticle:hydration-complete` signal
 * exactly once, letting the agent wait for interactivity instead of clicking into the void. Pure
 * tracker; the commit hook drives it, the SDK emits the signal.
 *
 * The signal fires on the first commit after which no server-rendered part waits for hydration, or at
 * install when React hydrated the page before the adapter loaded (#1654). Next installs the adapter in a
 * `useEffect`, after the shell committed: a signal that waited for the next commit never came on a
 * quiet page, and one that fired on any commit came before a slow Suspense boundary had handlers.
 */

import { RETICLE_HYDRATION_SIGNAL } from '@reticlehq/core';
import { HydrationState } from './hydration-state.js';

/** The signal fired once React has hydrated the page (handlers attached). */
export const HYDRATION_COMPLETE_SIGNAL = RETICLE_HYDRATION_SIGNAL;

export interface HydrationTracker {
  /** Call on every React commit; fires `onHydrated` once, when no part waits for hydration. */
  onCommit(): void;
  /** Call once at install; fires `onHydrated` when React already hydrated the whole page. */
  onInstall(): void;
  isHydrated(): boolean;
}

/**
 * @param read The page's hydration state. The default says DONE, so a tracker without one fires on the
 *   first commit, as it did before.
 */
export function createHydrationTracker(
  onHydrated: () => void,
  read: () => HydrationState = () => HydrationState.DONE,
): HydrationTracker {
  let hydrated = false;
  const settle = (ready: (state: HydrationState) => boolean): void => {
    if (hydrated || !ready(read())) {
      return;
    }
    hydrated = true;
    onHydrated();
  };
  return {
    // A commit means React rendered, so only a part that still waits holds the signal back.
    onCommit: (): void => {
      settle((state) => HydrationState.PENDING !== state);
    },
    // At install React may not have rendered yet. Then the first commit decides.
    onInstall: (): void => {
      settle((state) => HydrationState.DONE === state);
    },
    isHydrated: (): boolean => hydrated,
  };
}

import {
  NavigateHistory,
  NavigateHistoryRefusal,
  type NavigateHistory as NavigateHistoryValue,
} from '@reticlehq/core/page';

/**
 * The page's own history, as the `history` command uses it. Injected so a test can see which way
 * the page was moved without moving the test document.
 */
export interface HistoryHost {
  back: () => void;
  forward: () => void;
  /**
   * Whether an entry exists in that direction. `undefined` means the browser cannot tell: only the
   * Navigation API knows where the tab is in its list, and `history.length` does not.
   */
  canGo?: (direction: NavigateHistoryValue) => boolean | undefined;
}

export type HistoryMoveResult = { ok: true } | { ok: false; reason: NavigateHistoryRefusal };

function isDirection(value: unknown): value is NavigateHistoryValue {
  return value === NavigateHistory.BACK || value === NavigateHistory.FORWARD;
}

/** The Navigation API's answer, or undefined when this browser has no Navigation API. */
function navigationCanGo(direction: NavigateHistoryValue): boolean | undefined {
  const navigation = (globalThis as { navigation?: unknown }).navigation;
  if ('object' !== typeof navigation || null === navigation) {
    return undefined;
  }
  const flags = navigation as { canGoBack?: unknown; canGoForward?: unknown };
  const flag = direction === NavigateHistory.BACK ? flags.canGoBack : flags.canGoForward;
  return 'boolean' === typeof flag ? flag : undefined;
}

/** The live page's history. */
export function pageHistoryHost(): HistoryHost {
  return {
    back: () => {
      history.back();
    },
    forward: () => {
      history.forward();
    },
    canGo: navigationCanGo,
  };
}

/**
 * Move the tab one entry back or forward.
 *
 * `ok:true` means the move was DISPATCHED, the same as `navigate`: `history.back()` returns before
 * the page moves, and a move to another document destroys this SDK. The daemon judges arrival.
 * A move the browser says cannot happen is refused here, because `history.back()` on the first
 * entry does nothing and reports nothing, and the daemon would wait its whole budget for it.
 */
export function moveThroughHistory(
  direction: unknown,
  host: HistoryHost = pageHistoryHost(),
): HistoryMoveResult {
  if (!isDirection(direction)) {
    return { ok: false, reason: NavigateHistoryRefusal.UNKNOWN_DIRECTION };
  }
  if (false === host.canGo?.(direction)) {
    return { ok: false, reason: NavigateHistoryRefusal.NO_ENTRY };
  }
  if (direction === NavigateHistory.BACK) {
    host.back();
  } else {
    host.forward();
  }
  return { ok: true };
}

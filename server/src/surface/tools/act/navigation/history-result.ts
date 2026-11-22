/**
 * What `reticle_navigate { history: "back" | "forward" }` reports (#1844).
 *
 * The page's `history` command returns before the tab moves, like `navigate`, so its `ok` means
 * the move was SENT. Whether the tab arrived is decided from what the arrival wait saw
 * (history-arrival.ts), and `confirmed:true` is only for a tab that was seen to stop. The move
 * itself is sent from navigate-history.ts, beside the tool.
 */
import { NavigateHistory, type NavigateHistory as NavigateHistoryValue } from '@reticlehq/core';
import type { HistoryArrival } from './history-arrival.js';

/** What the tool says about a history move, beside the page's own refusals. */
export const HistoryNavigateMessage = {
  /** `history` came with `url` or `reload`. Each one moves the tab, and one call does one move. */
  ONE_KIND: 'Give one of url, reload or history in one call.',
  /** The tab did not leave its page within the wait. */
  NOT_SEEN:
    'ok means the move was sent, not that the tab arrived. The tab did not leave its page within ' +
    'waitedMs. A slow page can still be on its way: call reticle_sessions to see where the tab ' +
    'is, and do not send the move again, because a second move goes one more entry. A tab that ' +
    'stays in place can mean that the move went to a frame, that a beforeunload prompt stopped ' +
    'it, or that the entry has the same URL as the page it left.',
  /** The tab moved, and was still moving when the wait ended. */
  STILL_MOVING:
    'The tab moved, and it was still moving when the wait ended. url is where it was last seen, ' +
    'not proof that it stopped there. Wait for the page you expect with reticle_wait_for, or give ' +
    'a larger timeout_ms.',
  /** The tab moved to a page with no Reticle SDK. Only a leased tab's browser can say where. */
  LEFT_APP:
    'The tab moved to a page with no Reticle SDK, so no session can act there. url is where the ' +
    'browser is now, read from the browser. Only browser-level actions apply there (navigate, ' +
    'screenshot). Navigate to the app again, and the lease reattaches.',
  /** The browser did not move a leased page that has no SDK. */
  LEASE_DID_NOT_MOVE: 'The leased page did not move through its history.',
} as const;

export function isHistoryDirection(value: unknown): value is NavigateHistoryValue {
  return value === NavigateHistory.BACK || value === NavigateHistory.FORWARD;
}

/** The answer for a move the page accepted, from what the wait saw after it. */
export function historyResult(
  direction: NavigateHistoryValue,
  arrival: HistoryArrival | null,
  waitedMs: number,
): Record<string, unknown> {
  const base = { ok: true, history: direction };
  if (null === arrival) {
    return { ...base, confirmed: false, waitedMs, note: HistoryNavigateMessage.NOT_SEEN };
  }
  if (arrival.settled) {
    return { ...base, confirmed: true, url: arrival.url, sessionId: arrival.sessionId };
  }
  return {
    ...base,
    confirmed: false,
    url: arrival.url,
    sessionId: arrival.sessionId,
    waitedMs,
    note: HistoryNavigateMessage.STILL_MOVING,
  };
}

/**
 * The answer for a tab that the browser saw at `url`, where no SDK came back. Not `confirmed`: no
 * session can act at that page, and that is what `confirmed` promises.
 */
export function leftAppResult(
  direction: NavigateHistoryValue,
  url: string,
  waitedMs: number,
): Record<string, unknown> {
  return {
    ok: true,
    history: direction,
    confirmed: false,
    url,
    waitedMs,
    note: HistoryNavigateMessage.LEFT_APP,
  };
}

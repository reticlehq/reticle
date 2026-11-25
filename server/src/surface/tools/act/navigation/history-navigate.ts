/**
 * The history branch of `reticle_navigate` (#1844): send the move, then wait for the tab to arrive.
 *
 * The tool's own helpers come in through `HistoryMoveDeps`, not by import. A navigation module that
 * imported from the tools directory would make the two directories need each other, because the
 * tools directory already needs this one. What the move reports is decided in history-result.ts.
 */
import {
  HISTORY_DIRECTION_ARG,
  NavigateHistoryRefusal,
  ProductionRule,
  ReticleTool,
  asNumber,
  asString,
  productionRefusal,
  type NavigateHistory,
} from '@reticlehq/core';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { ARRIVAL_TIMEOUT_MS, idsOpenAtDispatch, samePage } from './navigate-arrival.js';
import { awaitHistoryArrival, awaitLeaseBack } from './history-arrival.js';
import {
  HistoryNavigateMessage,
  historyResult,
  isHistoryDirection,
  leftAppResult,
} from './history-result.js';

/**
 * The browser side of a leased tab: the pool's `historyLease`, `leasePageUrl` and `leaseUrl`.
 * Absent where no pool runs, and then every tab moves through its SDK.
 */
export interface HistoryLease {
  /** True when this id names a live lease. */
  isLease: (sessionId: string) => boolean;
  /** Move the leased page through the browser. False when it did not move. */
  move: (sessionId: string, direction: NavigateHistory, timeoutMs: number) => Promise<boolean>;
  /** Where the leased page is, read from the browser. */
  pageUrl: (sessionId: string) => string | undefined;
  /** True when a production drive guards this lease. */
  isGuarded: (sessionId: string) => boolean;
}

/** What a history move needs from the tool that runs it. */
export interface HistoryMoveDeps {
  sessions: SessionManager;
  /** Send the page's `history` command. Throws when the page does not take the command at all. */
  sendHistory: (sessionId: string | undefined, args: Record<string, unknown>) => Promise<unknown>;
  /** Move the recordings' navigation mark, as every other navigation does. */
  markRecordingsNavigated: () => void;
  lease?: HistoryLease;
}

/**
 * Move a lease whose page has no SDK through the browser, then wait for its SDK to reattach. Where
 * none reattaches, the browser says where the page is, because nothing else can.
 */
async function moveLeaseInBrowser(
  deps: HistoryMoveDeps,
  lease: HistoryLease,
  sessionId: string,
  direction: NavigateHistory,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const before = lease.pageUrl(sessionId);
  deps.markRecordingsNavigated();
  if (!(await lease.move(sessionId, direction, timeoutMs))) {
    return { ok: false, history: direction, reason: HistoryNavigateMessage.LEASE_DID_NOT_MOVE };
  }
  const back = await awaitLeaseBack(deps.sessions, sessionId, timeoutMs);
  if (back !== null) {
    return historyResult(direction, back, timeoutMs);
  }
  const now = lease.pageUrl(sessionId);
  if (now === undefined || now === before) {
    return historyResult(direction, null, timeoutMs);
  }
  return leftAppResult(direction, now, timeoutMs);
}

/** Move the tab one entry back or forward, then wait for it to arrive. */
export async function navigateHistory(
  deps: HistoryMoveDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (args['url'] !== undefined || true === args['reload']) {
    return { ok: false, reason: HistoryNavigateMessage.ONE_KIND };
  }
  const direction = args['history'];
  if (!isHistoryDirection(direction)) {
    return { ok: false, reason: NavigateHistoryRefusal.UNKNOWN_DIRECTION };
  }
  const sessionId = asString(args['sessionId']);
  const timeoutMs = asNumber(args['timeout_ms']) ?? ARRIVAL_TIMEOUT_MS;
  const lease = deps.lease;
  // A lease whose page has no SDK right now (it went to an image, a PDF, another site) cannot take
  // the page's command, but its browser can still move it, as the URL path does (navigateLease).
  if (
    sessionId !== undefined &&
    deps.sessions.get(sessionId) === undefined &&
    true === lease?.isLease(sessionId)
  ) {
    // The move through the browser does not pass the daemon's command gate, where a production
    // drive refuses a history move. So a guarded lease is refused here, before the page moves.
    if (lease.isGuarded(sessionId)) {
      return {
        ok: false,
        history: direction,
        reason: productionRefusal(ProductionRule.HISTORY_MOVE),
      };
    }
    return moveLeaseInBrowser(deps, lease, sessionId, direction, timeoutMs);
  }
  const session = deps.sessions.resolve(sessionId);
  // Sampled BEFORE dispatch, for the same reason as on the URL path: the new document can connect
  // while the command reply is still on its way, and then it would read as the starting point.
  const scope = {
    navigatedSession: session,
    navigatedFrom: session.url,
    sentAt: session.elapsed(),
    ...(session.currentDocumentId === undefined
      ? {}
      : { navigatedFromDocumentId: session.currentDocumentId }),
    priorIds: idsOpenAtDispatch(deps.sessions),
  };
  session.beginAction(ReticleTool.NAVIGATE, { history: direction });
  // The verdict floor moves before the page goes away, as on every other navigation: a later
  // assert must not judge the requests of the page this move left behind.
  session.lastAct.markNavigated(session.elapsed());
  deps.markRecordingsNavigated();
  try {
    const sent = (await deps.sendHistory(sessionId, { [HISTORY_DIRECTION_ARG]: direction })) as {
      ok?: unknown;
      reason?: unknown;
    };
    // A refusal is conclusive: the tab did not move, so there is nothing to wait for.
    if (true !== sent.ok) {
      return {
        ok: false,
        history: direction,
        ...('string' === typeof sent.reason ? { reason: sent.reason } : {}),
      };
    }
    const arrival = await awaitHistoryArrival(deps.sessions, scope, timeoutMs);
    // No session saw the move. On a lease the browser can still say where the tab went: back from
    // the first app page reaches the about:blank the lease was opened on, where no SDK runs.
    const browserUrl = null === arrival ? lease?.pageUrl(session.id) : undefined;
    if (browserUrl !== undefined && !samePage(browserUrl, scope.navigatedFrom)) {
      return leftAppResult(direction, browserUrl, timeoutMs);
    }
    return historyResult(direction, arrival, timeoutMs);
  } finally {
    session.finishAction();
  }
}

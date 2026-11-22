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
  ReticleTool,
  asNumber,
  asString,
} from '@reticlehq/core';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { ARRIVAL_TIMEOUT_MS, idsOpenAtDispatch } from './navigate-arrival.js';
import { awaitHistoryArrival } from './history-arrival.js';
import { HistoryNavigateMessage, historyResult, isHistoryDirection } from './history-result.js';

/** What a history move needs from the tool that runs it. */
export interface HistoryMoveDeps {
  sessions: SessionManager;
  /** Send the page's `history` command. Throws when the page does not take the command at all. */
  sendHistory: (sessionId: string | undefined, args: Record<string, unknown>) => Promise<unknown>;
  /** Move the recordings' navigation mark, as every other navigation does. */
  markRecordingsNavigated: () => void;
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
  const session = deps.sessions.resolve(sessionId);
  // Sampled BEFORE dispatch, for the same reason as on the URL path: the new document can connect
  // while the command reply is still on its way, and then it would read as the starting point.
  const scope = {
    navigatedSession: session,
    navigatedFrom: session.url,
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
    const timeoutMs = asNumber(args['timeout_ms']) ?? ARRIVAL_TIMEOUT_MS;
    const arrival = await awaitHistoryArrival(deps.sessions, scope, timeoutMs);
    return historyResult(direction, arrival, timeoutMs);
  } finally {
    session.finishAction();
  }
}

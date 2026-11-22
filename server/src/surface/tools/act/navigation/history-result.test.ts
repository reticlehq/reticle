/**
 * How a history move is reported, for each thing the arrival wait can find (#1844).
 *
 * `confirmed:true` is only for a tab that was seen to stop. A tab still moving when the wait ended
 * says where it was last seen, and says that this is not where it stopped.
 */
import { describe, expect, it } from 'vitest';
import { NavigateHistory } from '@reticlehq/core';
import { HistoryNavigateMessage, historyResult } from './history-result.js';

const ORDERS = 'http://localhost:3000/orders';

describe('historyResult', () => {
  it('confirms a tab that was seen to stop, with its URL and session', () => {
    expect(
      historyResult(NavigateHistory.BACK, { sessionId: 's2', url: ORDERS, settled: true }, 5_000),
    ).toEqual({
      ok: true,
      history: NavigateHistory.BACK,
      confirmed: true,
      url: ORDERS,
      sessionId: 's2',
    });
  });

  it('does not confirm a tab still moving when the wait ended, and says so', () => {
    expect(
      historyResult(NavigateHistory.BACK, { sessionId: 's1', url: ORDERS, settled: false }, 300),
    ).toEqual({
      ok: true,
      history: NavigateHistory.BACK,
      confirmed: false,
      url: ORDERS,
      sessionId: 's1',
      waitedMs: 300,
      note: HistoryNavigateMessage.STILL_MOVING,
    });
  });

  it('does not confirm a move nobody saw, and names no URL for it', () => {
    expect(historyResult(NavigateHistory.FORWARD, null, 300)).toEqual({
      ok: true,
      history: NavigateHistory.FORWARD,
      confirmed: false,
      waitedMs: 300,
      note: HistoryNavigateMessage.NOT_SEEN,
    });
  });
});

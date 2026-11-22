import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  HISTORY_DIRECTION_ARG,
  NavigateHistory,
  NavigateHistoryRefusal,
  ReticleCommand,
} from '@reticlehq/core';
import { moveThroughHistory, type HistoryHost } from './history-move.js';
import { createCommandRegistry } from './commands.js';

type Move = () => void;

function host(can?: { back?: boolean; forward?: boolean }): HistoryHost & {
  back: Mock<Move>;
  forward: Mock<Move>;
} {
  return {
    back: vi.fn<Move>(),
    forward: vi.fn<Move>(),
    ...(can === undefined ? {} : { canGo: (direction) => can[direction] }),
  };
}

describe('the history command moves the tab through its history (#1844)', () => {
  it('goes back one entry', () => {
    const h = host();
    expect(moveThroughHistory(NavigateHistory.BACK, h)).toEqual({ ok: true });
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.forward).not.toHaveBeenCalled();
  });

  it('goes forward one entry', () => {
    const h = host();
    expect(moveThroughHistory(NavigateHistory.FORWARD, h)).toEqual({ ok: true });
    expect(h.forward).toHaveBeenCalledTimes(1);
    expect(h.back).not.toHaveBeenCalled();
  });

  it('refuses a direction that is not back or forward, and moves nothing', () => {
    const h = host();
    expect(moveThroughHistory('sideways', h)).toEqual({
      ok: false,
      reason: NavigateHistoryRefusal.UNKNOWN_DIRECTION,
    });
    expect(h.back).not.toHaveBeenCalled();
    expect(h.forward).not.toHaveBeenCalled();
  });

  it('refuses when the browser reports no entry in that direction', () => {
    // history.back() on the first entry does nothing and says nothing. Without this refusal the
    // daemon waits the whole budget for a move that never starts, and reports a slow page.
    const h = host({ back: false, forward: true });
    expect(moveThroughHistory(NavigateHistory.BACK, h)).toEqual({
      ok: false,
      reason: NavigateHistoryRefusal.NO_ENTRY,
    });
    expect(h.back).not.toHaveBeenCalled();
  });

  it('moves when the browser cannot tell whether an entry exists', () => {
    // A browser without the Navigation API: history.length does not say where the tab is in its
    // list, so the command moves and the daemon judges arrival.
    const h = host({});
    expect(moveThroughHistory(NavigateHistory.FORWARD, h)).toEqual({ ok: true });
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it('is served by the command registry under its wire name', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    try {
      const handler = createCommandRegistry().get(ReticleCommand.HISTORY);
      expect(handler).toBeDefined();
      expect(handler?.({ [HISTORY_DIRECTION_ARG]: NavigateHistory.BACK })).toEqual({ ok: true });
      expect(back).toHaveBeenCalledTimes(1);
    } finally {
      back.mockRestore();
    }
  });
});

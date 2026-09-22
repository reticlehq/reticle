import { describe, expect, it } from 'vitest';
import { LastAct } from '@/portal/session/last-act.js';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  ReticleTool,
  SessionState,
  TruncationChannel,
  Verified,
  VerifiedReason,
  type JournalWriteLoss,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * A verdict drawn from a ledger that stopped writing must not come back green.
 *
 * `reticle_assert` reads its window through `queryEvents`, which falls through to the durable
 * journal once the ring buffer has evicted — permanently, about a minute into any session. That
 * journal refuses writes at its byte ceiling, so on a session that hit the cap the window an
 * absence assertion reads is missing exactly the evidence that would have failed it.
 *
 * The in-band `truncated` record cannot carry this on its own. It is stamped with the `t` of the
 * last refused event and `filterEvents` bounds on `t`, so a window opened after the cap sees no
 * marker at all — a durable partial answer indistinguishable from a complete one. The out-of-band
 * report is what survives that, and this pins it onto the verdict an agent actually gates on.
 */

/** Elapsed ms the ledger closed at — the stamp the in-band marker carries and a window filters on. */
const CLOSED_AT_MS = 900;

const LOSS: JournalWriteLoss = {
  v: JOURNAL_FILE_VERSION,
  channel: TruncationChannel.JOURNAL,
  capBytes: 64 * 1024 * 1024,
  bytesOnDisk: 64 * 1024 * 1024 - 120,
  droppedInBatch: 8,
  at: CLOSED_AT_MS,
};

function depsWithJournal(
  loss: JournalWriteLoss | undefined,
  events: ReticleEvent[] = [],
): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    bufferHealth: () => ({ total: 12, dropped: 12 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    eventsSince: () => events,
    queryEvents: () => Promise.resolve(events),
    journalWriteLoss: () => Promise.resolve(loss),
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const absentConsole = {
  predicate: { kind: 'console', level: 'error', absent: true },
  timeout_ms: 0,
};

describe('assert does not grade a window read from a ledger that stopped writing', () => {
  it('refuses a green on an absence claim when the durable ledger was closed at its cap', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithJournal(LOSS),
      absentConsole,
    )) as { pass: boolean; verified?: string; verifiedReason?: string; because?: string };
    expect(result.pass).toBe(true);
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
    // The sentence has to name WHICH loss, or the agent is told its capture was dirty and left to
    // guess between a ring buffer it can do nothing about and a ledger that is full.
    expect(result.because).toMatch(/ledger/i);
  });

  it('still refuses when the window opened AFTER the cap, where the in-band marker cannot reach', async () => {
    // The window filter has already dropped the marker: the events this assertion reads contain no
    // declaration of any kind, which is precisely the state that used to grade `yes`.
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithJournal(LOSS), {
      ...absentConsole,
      since: CLOSED_AT_MS + 1,
    })) as { verified?: string; verifiedReason?: string };
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('grades normally when the ledger never closed', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithJournal(undefined),
      absentConsole,
    )) as { verified?: string };
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });

  it('does not impeach a POSITIVE assertion that found its evidence', async () => {
    // Same rule the buffer path draws: events missing from the END of a ledger do not unmake a
    // request that was observed. Impeaching every claim over a capped session would make `unknown`
    // the answer to everything, which this repo has already paid for once.
    const apiCall: ReticleEvent[] = [
      {
        t: 1,
        type: EventType.NET_REQUEST,
        sessionId: 'demo',
        data: { method: 'GET', url: 'http://localhost/api/items', status: 200, ok: true },
      },
    ];
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithJournal(LOSS, apiCall), {
      predicate: { kind: 'net', urlContains: '/api' },
      timeout_ms: 0,
    })) as { pass: boolean; verified?: string };
    expect(result.pass).toBe(true);
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });
});

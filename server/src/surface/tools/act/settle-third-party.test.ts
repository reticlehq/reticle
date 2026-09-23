/**
 * Somebody else's beacon must not hold this window open.
 *
 * This file already drops the dev toolchain, and the comment beside that exclusion makes the whole
 * argument: "`evalSettled` and `findContradictions` both drop it already; this file read the raw
 * window, so the exclusion was cosmetic exactly where it decides a verdict." That was right, and it
 * was applied to only one of the two origin classes those other two drop. `splitForeignTraffic`
 * excludes dev tooling AND third-party traffic; this excluded dev tooling alone.
 *
 * The consequence, reported from the field more than once: an app embedding a wallet SDK that
 * continuously POSTs telemetry to its own vendor host never settles, so **every** `reticle_assert`
 * on that app returns `unknown / outcome_pending` regardless of the feature under test. Same shape
 * for a signed-out auth probe and an analytics beacon — none of them is the app finishing its work,
 * and none of them can be waited for, because nothing makes them stop.
 *
 * A third-party host is not the app under test. It cannot answer the question the settle check asks
 * ("has the app finished?"), and waiting for it to is waiting forever.
 *
 * SAME-ORIGIN background traffic (`POST /api/analytics/events` on the app's own host) is NOT
 * covered here and deliberately so: nothing in a URL distinguishes the app's telemetry from the
 * app's work, and guessing would suppress the very requests a verdict rests on. That case needs a
 * declaration from the project, which is separate work.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { inFlightRequestIds, inFlightRequestLabels } from './settle-in-flight.js';

const APP = 'http://localhost:4312/deployments';

const pending = (id: string, url: string): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_PENDING,
  data: { id, url, method: 'POST' },
});

const done = (id: string): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_REQUEST,
  data: { id },
});

describe('a third-party request does not keep the window unsettled', () => {
  it('ignores a vendor telemetry beacon that never comes back', () => {
    const events = [pending('w1', 'https://pulse.walletconnect.org/e')];
    expect(inFlightRequestIds(events, APP)).toEqual([]);
  });

  it('ignores it in the labels too, so the verdict does not name it as the cause', () => {
    const events = [pending('w1', 'https://pulse.walletconnect.org/e')];
    expect(inFlightRequestLabels(events, APP)).toEqual([]);
  });

  it("still holds the window open for the APP's own in-flight request", () => {
    const events = [pending('a1', 'http://localhost:4312/api/order')];
    expect(inFlightRequestIds(events, APP)).toEqual(['a1']);
  });

  it('keeps the app request and drops the beacon when both are in flight', () => {
    const events = [
      pending('w1', 'https://pulse.walletconnect.org/e'),
      pending('a1', 'http://localhost:4312/api/order'),
    ];
    expect(inFlightRequestIds(events, APP)).toEqual(['a1']);
  });

  /**
   * Same-origin traffic is NOT filtered, whatever it looks like. A verdict must never be decided by
   * guessing that a path on the app's own host is "just telemetry".
   */
  it('does not guess that a same-origin analytics path is background', () => {
    const events = [pending('s1', 'http://localhost:4312/api/analytics/events')];
    expect(inFlightRequestIds(events, APP)).toEqual(['s1']);
  });

  /** With no app origin known, nothing can be called foreign — fail open, never suppress. */
  it('suppresses nothing when the app origin is unknown', () => {
    const events = [pending('w1', 'https://pulse.walletconnect.org/e')];
    expect(inFlightRequestIds(events, undefined)).toEqual(['w1']);
  });

  /** A settled third-party request was never outstanding either way — no behaviour change. */
  it('is unaffected when the beacon does come back', () => {
    const events = [pending('w1', 'https://pulse.walletconnect.org/e'), done('w1')];
    expect(inFlightRequestIds(events, APP)).toEqual([]);
  });
});

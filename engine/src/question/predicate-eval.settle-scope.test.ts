/**
 * `settled` counted requests that everything else in the product ignores — so after a plain link
 * click it could never pass again, and the agents who hit it dropped `settled` from their `until`.
 *
 * Two kinds were being counted that no other settle decision counts:
 *
 *   - **Departures.** `NetInitiator.NAVIGATION` records where the browser was SENT, as an unmatched
 *     `NET_PENDING` that by construction never completes — the response goes to a document this
 *     session does not live into. `settle-in-flight.ts` excludes it and `core/src/wire/net.ts` says
 *     it must be; `evalSettled` counted it, so the first click on an outbound link wedged settle on
 *     that page for the rest of the session.
 *   - **Foreign traffic.** A vendor beacon or a declared same-origin background endpoint is not the
 *     app finishing its work. The act settle-wait and the contradiction pass drop both; `evalSettled`
 *     dropped neither, so an app embedding a wallet SDK that POSTs telemetry forever never settled
 *     and EVERY assertion on it came back `unknown / outcome_pending`.
 *
 * The exclusions are DISCLOSED, never silent: a verdict has to be able to say which requests it
 * declined to wait for. And each one has an over-exclusion guard beside it — the same reasoning that
 * makes the dev-tooling exclusion safe applies here, and excluding a real request would turn this
 * false negative into a false green.
 */

import { describe, expect, it } from 'vitest';
import {
  EventType,
  NetInitiator,
  REDACTED_VALUE,
  URL_RAW,
  type ReticleEvent,
} from '@reticlehq/core';
import { evalSettled, type EvalResult } from './predicate/predicate-eval.js';

const APP = 'http://localhost:3000/';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, t = ++seq): ReticleEvent {
  return { t, type, sessionId: 's', data };
}
const pending = (id: string, url: string, extra: Record<string, unknown> = {}): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'GET', url, ...extra });

const settled = { kind: 'settled', quietMs: 500 } as const;
/** Hours after the last event, so a failure can only be the in-flight count, never the quiet timer. */
const LONG_AFTER = 100_000;

/** What the verdict said it declined to wait for — `evidence` is optional, so narrow through it. */
const ignoredOf = (r: EvalResult, key: 'ignoredForeign' | 'ignoredDepartures'): readonly string[] =>
  (r.evidence as Record<string, string[] | undefined> | undefined)?.[key] ?? [];
const ignoredForeignOf = (r: EvalResult): readonly string[] => ignoredOf(r, 'ignoredForeign');
const ignoredDeparturesOf = (r: EvalResult): readonly string[] => ignoredOf(r, 'ignoredDepartures');

describe('evalSettled — a departure is not an outstanding request', () => {
  it('settles over a navigation departure, which can never be matched', () => {
    const departure = pending('nav-1', 'https://accounts.google.com/o/oauth2', {
      initiator: NetInitiator.NAVIGATION,
    });
    expect(evalSettled([departure], settled, LONG_AFTER).pass).toBe(true);
  });

  it('names the departure it ignored rather than swallowing it', () => {
    const departure = pending('nav-1', 'https://accounts.google.com/o/oauth2', {
      initiator: NetInitiator.NAVIGATION,
    });
    const r = evalSettled([departure], settled, LONG_AFTER);
    expect(ignoredDeparturesOf(r)).toEqual(['https://accounts.google.com/o/oauth2']);
  });

  // One classification, two explanations. A reader told "somebody else's host" about a page that
  // simply left is sent to look for a third-party call that does not exist.
  it('reports a departure AS a departure, never as foreign traffic', () => {
    const departure = pending('nav-1', 'https://accounts.google.com/o/oauth2', {
      initiator: NetInitiator.NAVIGATION,
    });
    expect(ignoredForeignOf(evalSettled([departure], settled, LONG_AFTER))).toEqual([]);
  });
});

describe('evalSettled — somebody else’s traffic is not the app finishing its work', () => {
  it('settles while only a third-party beacon is in flight', () => {
    const beacon = pending('v1', 'https://vendor.example/beacon');
    expect(evalSettled([beacon], settled, LONG_AFTER, { appUrl: APP }).pass).toBe(true);
    expect(ignoredForeignOf(evalSettled([beacon], settled, LONG_AFTER, { appUrl: APP }))).toEqual([
      'https://vendor.example/beacon',
    ]);
  });

  it('settles while only a DECLARED same-origin background endpoint is in flight', () => {
    const poll = pending('b1', `${APP}api/analytics/events`);
    expect(
      evalSettled([poll], settled, LONG_AFTER, { appUrl: APP, background: ['/api/analytics'] })
        .pass,
    ).toBe(true);
  });

  it('does not exclude anything when nobody said which page is under test', () => {
    const beacon = pending('v1', 'https://vendor.example/beacon');
    const r = evalSettled([beacon], settled, LONG_AFTER);
    expect(r.pass).toBe(false);
    expect(ignoredForeignOf(r)).toEqual([]);
  });

  /**
   * Redaction rewrites a sensitive path segment at emit time and keeps the original only in
   * `urlRaw`, so classifying on the displayed url let a declared endpoint back into the count —
   * through the one field the classifier did not consult. `urlForMatch` is the field that exists
   * for this, and every other url comparison in the product already splits them that way.
   */
  it('recognises a declared endpoint whose path was redacted', () => {
    const redacted = pending('t1', `${APP}verify/[REDACTED]`, {
      urlRaw: `${APP}verify/refresh-token`,
    });
    expect(
      evalSettled([redacted], settled, LONG_AFTER, {
        appUrl: APP,
        background: ['/verify/refresh-token'],
      }).pass,
    ).toBe(true);
  });

  it('discloses the DISPLAYED url for it, never the raw one', () => {
    const redacted = pending('t1', `${APP}verify/[REDACTED]`, {
      urlRaw: `${APP}verify/refresh-token`,
    });
    const r = evalSettled([redacted], settled, LONG_AFTER, {
      appUrl: APP,
      background: ['/verify/refresh-token'],
    });
    expect(ignoredForeignOf(r).join(' ')).not.toContain('refresh-token');
  });

  // ── over-exclusion guard ──────────────────────────────────────────────────────────────────────
  it('still blocks on the app’s OWN request, foreign traffic alongside it or not', () => {
    const r = evalSettled(
      [pending('v1', 'https://vendor.example/beacon'), pending('r1', `${APP}api/save`)],
      settled,
      LONG_AFTER,
      { appUrl: APP },
    );
    expect(r.pass).toBe(false);
    expect((r.evidence as { inFlight: number }).inFlight).toBe(1);
  });

  it('does not exclude an undeclared same-origin endpoint — telemetry is never guessed at', () => {
    const poll = pending('b1', `${APP}api/analytics/events`);
    expect(evalSettled([poll], settled, LONG_AFTER, { appUrl: APP }).pass).toBe(false);
  });

  it('matches a declared endpoint against the RAW url, not the redacted one', () => {
    // Redaction rewrites the segment that follows a sensitive name at EMIT time
    // (`/auth/token/9f2c…` -> `/auth/token/[REDACTED]`), and a declaration is matched with
    // `String.includes`. Classifying on the displayed URL would therefore miss a project's own
    // endpoint the moment the redactor touched it — putting the request back in the in-flight count,
    // which is the exact wedge this branch exists to remove.
    const raw = `${APP}api/auth/token/9f2c7ab41d5e8036`;
    const shown = `${APP}api/auth/token/${REDACTED_VALUE}`;
    const poll = ev(EventType.NET_PENDING, {
      id: 'b1',
      method: 'POST',
      url: shown,
      [URL_RAW]: raw,
    });
    const r = evalSettled([poll], settled, LONG_AFTER, { appUrl: APP, background: [raw] });
    expect(r.pass).toBe(true);
    // Disclosed as the READER saw it: the transcript gets the displayed URL, never the raw one.
    expect(ignoredForeignOf(r)).toEqual([shown]);
  });

  it('does not let an ignored request reset the quiet timer', () => {
    const beacon = ev(
      EventType.NET_REQUEST,
      { id: 'v1', method: 'POST', url: 'https://vendor.example/beacon', status: 200 },
      990,
    );
    expect(evalSettled([beacon], settled, 1000, { appUrl: APP }).pass).toBe(true);
  });
});

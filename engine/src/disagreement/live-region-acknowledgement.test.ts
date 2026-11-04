/**
 * Error text that the app writes into an existing alert region acknowledges the failure.
 *
 * Reported from the field (#2173). A login POST answered 401, and the app wrote "Wrong email or
 * password" into a `<div role="alert">` that was already on the page. Only a MOUNTED alert counted,
 * so the verdict was `unknown` without a store and `no` (`ui-advanced-request-failed`) with one.
 *
 * Only an assertive region counts (`role="alert"` or `aria-live="assertive"`). ARIA keeps that
 * level for errors and urgent warnings. A polite region (`role="status"`) is where an app writes
 * "Saved", so text there over a failed write stays `no`. The words do not decide.
 */
import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  EventType,
  LivePoliteness,
  PredicateKind,
  Verified,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '@/question/declared.js';
import { decideVerified } from '@/evidence/verified.js';
import { HonestyGrade } from '@/evidence/honesty.js';

const LOGIN_URL = '/api/login';
const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
const WRONG_PASSWORD = 'Wrong email or password';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}
const sent = (id: string): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'POST', url: LOGIN_URL });
const answered = (id: string, status: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id, method: 'POST', url: LOGIN_URL, status, ok: status < 400 });
const stored = (path: string, value: unknown): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { path, value });
const text = (shown: string, live?: LivePoliteness): ReticleEvent =>
  ev(EventType.DOM_TEXT, live === undefined ? { text: shown } : { text: shown, live });

/** The act path, as far as the engine owns it: every declared clause passed. */
function verdictOf(events: readonly ReticleEvent[], predicate: Predicate) {
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(events, {
    action: 'click',
    actionSince: 0,
    prior: [],
    mutatedWithin: 1,
    expectedFailures: declared.netFailures,
    namedNetUrls: declared.netUrls,
    renderProved: declared.rendersContent,
  });
  const { verified } = decideVerified({
    pass: true,
    declaredConsequence: true,
    settled: true,
    contradictions,
    honesty: {
      grade: HonestyGrade.SIGNAL,
      attribution: 'window',
      coverage: { partial: false },
      integrity: { clean: true, issues: [] },
    },
  });
  return { verified, kinds: contradictions.map((c) => c.kind) };
}

const shows = (contains: string): Predicate => ({ kind: PredicateKind.TEXT, contains });

describe('error text written into an existing alert region', () => {
  it('verifies a 401 whose error text lands in the alert region, with a store change', () => {
    const events = [
      sent('w1'),
      answered('w1', UNAUTHORIZED),
      stored('auth.pending', false),
      text(WRONG_PASSWORD, LivePoliteness.ASSERTIVE),
    ];
    expect(verdictOf(events, shows(WRONG_PASSWORD))).toEqual({ verified: Verified.YES, kinds: [] });
  });

  it('verifies a 401 whose error text lands in the alert region, with no store', () => {
    const events = [
      sent('w1'),
      answered('w1', UNAUTHORIZED),
      text(WRONG_PASSWORD, LivePoliteness.ASSERTIVE),
    ];
    expect(verdictOf(events, shows(WRONG_PASSWORD))).toEqual({ verified: Verified.YES, kinds: [] });
  });

  it('verifies alert text that the app wrote before the observer recorded the answer', () => {
    const events = [
      sent('w1'),
      text(WRONG_PASSWORD, LivePoliteness.ASSERTIVE),
      stored('auth.pending', false),
      answered('w1', UNAUTHORIZED),
    ];
    expect(verdictOf(events, shows(WRONG_PASSWORD))).toEqual({ verified: Verified.YES, kinds: [] });
  });
});

describe('text that is not an acknowledgement', () => {
  const refused = (events: readonly ReticleEvent[], contains: string) => {
    const verdict = verdictOf(events, shows(contains));
    expect(verdict.verified).toBe(Verified.NO);
    expect(verdict.kinds).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  };

  it('refuses a 401 while a plain element says "Welcome back" and the store signs in', () => {
    refused(
      [
        sent('w1'),
        answered('w1', UNAUTHORIZED),
        stored('auth.signedIn', true),
        text('Welcome back'),
      ],
      'Welcome back',
    );
  });

  it('refuses "Saved" written into a polite status region over a 500', () => {
    refused(
      [
        sent('w1'),
        answered('w1', SERVER_ERROR),
        stored('profile.saved', true),
        text('Saved', LivePoliteness.POLITE),
      ],
      'Saved',
    );
  });

  it('refuses alert text that the app wrote before the call was sent', () => {
    refused(
      [
        text('Check your details', LivePoliteness.ASSERTIVE),
        sent('w1'),
        answered('w1', SERVER_ERROR),
        stored('auth.signedIn', true),
      ],
      'Check your details',
    );
  });

  it('refuses an alert region that the app cleared over a failed write', () => {
    refused(
      [
        sent('w1'),
        answered('w1', SERVER_ERROR),
        stored('auth.signedIn', true),
        text('', LivePoliteness.ASSERTIVE),
      ],
      'Welcome',
    );
  });
});

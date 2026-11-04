/**
 * A signal that the app fired before it sent a declared failed write is not a success claim about it.
 *
 * Reported from the field (#2172, split from #984): the caller declared `net { POST, status: 409 }`,
 * the server answered 409, and every clause passed. A `form:submit` signal that fired on the click,
 * before the request left, turned the verdict into `no` (`signal-contradicted`). Without the signal,
 * the same window verifies.
 *
 * The other direction is the false green this rule exists for: an app that announces success over a
 * write that failed. That must stay `no`, also when the observer records the failed response after
 * the app's own handler fired its signal.
 */
import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  EventType,
  PredicateKind,
  Verified,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '@/question/declared.js';
import { decideVerified } from '@/evidence/verified.js';
import { HonestyGrade } from '@/evidence/honesty.js';

const INVITES_URL = '/api/team/invites';
const SIGNUP_URL = '/api/signup';
const DUPLICATE_EMAIL = 'Another account already uses this email.';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}
const signal = (name: string): ReticleEvent => ev(EventType.SIGNAL, { name });
const sent = (id: string, url: string): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'POST', url });
const answered = (id: string, url: string, status: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id, method: 'POST', url, status, ok: status < 400 });
const shown = (text: string): ReticleEvent => ev(EventType.DOM_TEXT, { text });

const invite409: Predicate = {
  kind: PredicateKind.ALL_OF,
  predicates: [
    { kind: PredicateKind.NET, method: 'POST', urlContains: '/invites', status: 409 },
    { kind: PredicateKind.TEXT, contains: DUPLICATE_EMAIL },
    { kind: PredicateKind.TEXT, contains: 'Invitation sent', absent: true },
  ],
};
const signup400: Predicate = {
  kind: PredicateKind.NET,
  method: 'POST',
  urlContains: SIGNUP_URL,
  status: 400,
  count: 1,
};

/** The act path, as far as the engine owns it: every declared clause passed. */
function verdictOf(events: readonly ReticleEvent[], predicate: Predicate) {
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(events, {
    action: 'click',
    actionSince: 0,
    prior: [],
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

describe('a signal fired before the declared failed write was sent', () => {
  it('verifies the declared 409', () => {
    const events = [
      signal('form:submit'),
      sent('w1', INVITES_URL),
      answered('w1', INVITES_URL, 409),
      shown(DUPLICATE_EMAIL),
    ];
    expect(verdictOf(events, invite409)).toEqual({ verified: Verified.YES, kinds: [] });
  });

  it('verifies the declared 400', () => {
    const events = [
      signal('analytics:track'),
      sent('w1', SIGNUP_URL),
      answered('w1', SIGNUP_URL, 400),
      shown('Email is required'),
    ];
    expect(verdictOf(events, signup400)).toEqual({ verified: Verified.YES, kinds: [] });
  });
});

describe('a success signal over a failed write is still a contradiction', () => {
  const refused = (kinds: readonly string[]) => {
    expect(kinds).toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  };

  it('refuses invite:sent fired after the declared 409', () => {
    const events = [
      sent('w1', INVITES_URL),
      answered('w1', INVITES_URL, 409),
      shown(DUPLICATE_EMAIL),
      signal('invite:sent'),
    ];
    const verdict = verdictOf(events, invite409);
    expect(verdict.verified).toBe(Verified.NO);
    refused(verdict.kinds);
  });

  // The observer reads a failed response's body before it records the answer, so the app's handler
  // can fire its signal first. The write was already sent, so the signal can be about its outcome.
  it('refuses invite:sent recorded after the write was sent but before its answer', () => {
    const events = [
      sent('w1', INVITES_URL),
      signal('invite:sent'),
      answered('w1', INVITES_URL, 409),
      shown(DUPLICATE_EMAIL),
    ];
    const verdict = verdictOf(events, invite409);
    expect(verdict.verified).toBe(Verified.NO);
    refused(verdict.kinds);
  });

  it('refuses an early signal when the failed write was not declared', () => {
    const textOnly: Predicate = { kind: PredicateKind.TEXT, contains: DUPLICATE_EMAIL };
    const events = [
      signal('form:submit'),
      sent('w1', INVITES_URL),
      answered('w1', INVITES_URL, 409),
      shown(DUPLICATE_EMAIL),
    ];
    const verdict = verdictOf(events, textOnly);
    expect(verdict.verified).toBe(Verified.NO);
    refused(verdict.kinds);
  });

  it('refuses an early signal when a second failed write was not declared', () => {
    const events = [
      signal('form:submit'),
      sent('w1', INVITES_URL),
      answered('w1', INVITES_URL, 409),
      sent('w2', '/api/audit'),
      answered('w2', '/api/audit', 500),
      shown(DUPLICATE_EMAIL),
    ];
    const verdict = verdictOf(events, invite409);
    expect(verdict.verified).toBe(Verified.NO);
    refused(verdict.kinds);
  });

  it('refuses an early signal when the window did not record when the write was sent', () => {
    const events = [
      signal('form:submit'),
      answered('w1', INVITES_URL, 409),
      shown(DUPLICATE_EMAIL),
    ];
    const verdict = verdictOf(events, invite409);
    expect(verdict.verified).toBe(Verified.NO);
    refused(verdict.kinds);
  });
});

/**
 * A store that records the failed call's HTTP status acknowledges the failure.
 *
 * Reported from the field (#2173, split from #984). Every declared clause passed, and the verdict
 * was `no` (`ui-advanced-request-failed`): the store kept a deliberate 429 as `status: 429` beside
 * a retry button. The store path had no English error word, so the rule read the retry UI as "the
 * UI moved on".
 *
 * The other direction stays `no`: a write that failed while the store claims success, a number in
 * the store that is not the failed status, and a write that the user repeats and that fails the
 * same way both times. A write that failed before the action is NOT exempt: the earlier failure
 * can be the user's own earlier click, and the UI that moves on the second click is a false `yes`.
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

const INVITES_URL = '/api/invites';
const ORDERS_URL = '/api/orders';
const TOO_MANY = 429;
const SERVER_ERROR = 500;

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, t?: number): ReticleEvent {
  seq += 1;
  return { t: t ?? seq, seq, type, sessionId: 's', data };
}
const net = (method: string, url: string, status: number, t?: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status, ok: status < 400 }, t);
const sent = (id: string, url: string): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'POST', url });
const answered = (id: string, url: string, status: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id, method: 'POST', url, status, ok: status < 400 });
const stored = (path: string, value: unknown, old?: unknown): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { path, value, old });

/** The act path, as far as the engine owns it: every declared clause passed. */
function verdictOf(
  events: readonly ReticleEvent[],
  predicate: Predicate,
  prior: readonly ReticleEvent[] = [],
) {
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(events, {
    action: 'click',
    actionSince: 0,
    prior,
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

const retryShown: Predicate = {
  kind: PredicateKind.ALL_OF,
  predicates: [
    { kind: PredicateKind.STATE, path: 'invites.lastStatus', equals: TOO_MANY },
    { kind: PredicateKind.ELEMENT, query: { role: 'button', name: 'Retry' } },
  ],
};
const retryButton = (): ReticleEvent => ev(EventType.DOM_ADDED, { role: 'button', name: 'Retry' });

describe('the store records the failed call status', () => {
  it('verifies a 429 that the store kept as a number', () => {
    const events = [
      net('POST', INVITES_URL, TOO_MANY),
      stored('invites.lastStatus', TOO_MANY),
      retryButton(),
    ];
    expect(verdictOf(events, retryShown)).toEqual({ verified: Verified.YES, kinds: [] });
  });

  it('verifies a 429 that the store kept before the observer recorded the answer', () => {
    const events = [
      sent('w1', INVITES_URL),
      stored('invites.lastStatus', TOO_MANY),
      answered('w1', INVITES_URL, TOO_MANY),
      retryButton(),
    ];
    expect(verdictOf(events, retryShown)).toEqual({ verified: Verified.YES, kinds: [] });
  });

  it('verifies a 429 that the store kept as a string inside an object', () => {
    const events = [
      net('POST', INVITES_URL, TOO_MANY),
      stored('invite', { status: String(TOO_MANY), message: 'Wait a minute, then retry.' }, {}),
      retryButton(),
    ];
    expect(verdictOf(events, retryShown)).toEqual({ verified: Verified.YES, kinds: [] });
  });
});

describe('a number in the store that is not an acknowledgement', () => {
  const refused = (events: readonly ReticleEvent[]) => {
    const verdict = verdictOf(events, retryShown);
    expect(verdict.verified).toBe(Verified.NO);
    expect(verdict.kinds).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  };

  it('refuses a 500 while the store says the invite was sent', () => {
    refused([
      net('POST', INVITES_URL, SERVER_ERROR),
      stored('invites.sent', true),
      ev(EventType.DOM_TEXT, { text: 'Invitation sent' }),
    ]);
  });

  it('refuses a store number that equals a different status', () => {
    refused([net('POST', INVITES_URL, SERVER_ERROR), stored('invites.count', TOO_MANY)]);
  });

  it('refuses a store number that equals the status of a call that succeeded', () => {
    refused([
      net('GET', '/api/team', 200),
      net('POST', INVITES_URL, SERVER_ERROR),
      stored('invites.count', 200),
    ]);
  });

  it('refuses the status number when the store wrote it before the call failed', () => {
    refused([
      stored('invites.limit', TOO_MANY),
      net('POST', INVITES_URL, TOO_MANY),
      ev(EventType.DOM_TEXT, { text: 'Invitation sent' }),
    ]);
  });

  it('refuses the status number when the store wrote it before the call was sent', () => {
    refused([
      stored('invites.limit', TOO_MANY),
      sent('w1', INVITES_URL),
      answered('w1', INVITES_URL, TOO_MANY),
    ]);
  });

  it('refuses an object whose status key did not change', () => {
    refused([
      net('POST', INVITES_URL, TOO_MANY),
      stored('invite', { status: TOO_MANY, sent: true }, { status: TOO_MANY, sent: false }),
    ]);
  });
});

describe('a write that failed the same way before the action', () => {
  it('refuses a repeated click whose write fails again while the UI moves on', () => {
    const prior = [
      net('POST', ORDERS_URL, SERVER_ERROR, -20),
      ev(EventType.DOM_TEXT, { text: 'Saving order' }, -19),
    ];
    const events = [
      net('POST', ORDERS_URL, SERVER_ERROR),
      stored('orders.saved', true),
      ev(EventType.DOM_TEXT, { text: 'Order saved' }),
    ];
    const verdict = verdictOf(events, { kind: PredicateKind.TEXT, contains: 'Order saved' }, prior);
    expect(verdict.verified).toBe(Verified.NO);
    expect(verdict.kinds).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });
});

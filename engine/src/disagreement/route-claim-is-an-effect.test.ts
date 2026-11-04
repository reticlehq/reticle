/**
 * A route claim that held is an effect of the action, also when the window is empty.
 *
 * Reported from the field (#2176, split from #984): a click did a full navigation, the declared
 * `route` predicate passed, and the verdict was `unknown` with `action-had-no-effect`. The SDK did
 * not record the navigation, so the window held no events, and the rule read "nothing happened".
 * The passing route clause is positive evidence against that inference.
 *
 * The other direction stays caught: a `settled` wait after a click on an inert target names no
 * consequence, so nothing proves the click did something. A route that was already true before the
 * action proves nothing about the action either.
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
import { declaredExpectations, provedConsequences } from '@/question/declared.js';
import { decideVerified } from '@/evidence/verified.js';
import { HonestyGrade } from '@/evidence/honesty.js';

const SETTINGS = '/settings';
const toSettings: Predicate = { kind: PredicateKind.ROUTE, pathname: SETTINGS };
const settled: Predicate = { kind: PredicateKind.SETTLED };

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

interface Run {
  /** The predicate held after the action. */
  pass?: boolean;
  /** The predicate already held before the action. */
  alreadyTrue?: boolean;
}

/** The act path, as far as the engine owns it. */
function verdictOf(events: readonly ReticleEvent[], predicate: Predicate, run: Run = {}) {
  const pass = run.pass ?? true;
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(events, {
    action: 'click',
    actionSince: 0,
    prior: [],
    mutatedWithin: 0,
    expectedFailures: declared.netFailures,
    namedNetUrls: declared.netUrls,
    ...provedConsequences(declared, pass && true !== run.alreadyTrue),
  });
  const { verified } = decideVerified({
    pass,
    declaredConsequence: PredicateKind.SETTLED !== predicate.kind,
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

describe('a click that navigated, with a passing route predicate', () => {
  it('verifies when the route change is in the window', () => {
    const events = [
      ev(EventType.ROUTE_CHANGE, { to: SETTINGS }),
      ev(EventType.DOM_ADDED, { role: 'heading', name: 'Settings' }),
    ];
    expect(verdictOf(events, toSettings).verified).toBe(Verified.YES);
  });

  it('verifies when the window recorded nothing (a full navigation the SDK did not see)', () => {
    expect(verdictOf([], toSettings)).toMatchObject({ verified: Verified.YES, kinds: [] });
  });

  it('verifies a route claim inside allOf', () => {
    const both: Predicate = { kind: PredicateKind.ALL_OF, predicates: [settled, toSettings] };
    expect(verdictOf([], both)).toMatchObject({ verified: Verified.YES, kinds: [] });
  });
});

describe('a click that did nothing is still caught', () => {
  it('refuses a settled wait after a click on an inert target', () => {
    const { verified, kinds } = verdictOf([], settled);
    expect(verified).not.toBe(Verified.YES);
    expect(kinds).toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('refuses a route claim that was already true before the click', () => {
    const { verified, kinds } = verdictOf([], toSettings, { alreadyTrue: true });
    expect(verified).not.toBe(Verified.YES);
    expect(kinds).toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('does not count a route clause that only one anyOf branch named', () => {
    const either: Predicate = { kind: PredicateKind.ANY_OF, predicates: [settled, toSettings] };
    expect(verdictOf([], either).kinds).toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('does not count a route claim that failed', () => {
    expect(provedConsequences(declaredExpectations(toSettings), false).routeProved).toBe(false);
  });
});

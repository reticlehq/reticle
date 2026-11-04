/**
 * A write that bumps an optimistic-lock token is a write that applied.
 *
 * Plain `version` was already skipped. The same token under the names that Rails (`lock_version`),
 * Mongoose (`__v`), SQL Server (`rowVersion`) and ASP.NET Identity (`concurrencyStamp`) use got
 * `no` with `write-field-ignored` (reticlehq/reticle#2174). Each case runs the same three steps the
 * act and assert paths run (declaredExpectations, findContradictions, decideVerified).
 *
 * The other direction stays caught: a dropped field beside the bump, a version-named field whose
 * echo is not a whole-number increase, and a lock token that went down.
 */
import { describe, expect, it } from 'vitest';
import {
  EventType,
  PredicateKind,
  Verified,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations, namedReactions } from '@/question/declared.js';
import { decideVerified } from '@/evidence/verified.js';
import { HonestyGrade } from '@/evidence/honesty.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const SUBMITTED = 'submitted';

function write(requestBody: unknown, responseBody: unknown): ReticleEvent {
  return ev(EventType.NET_REQUEST, {
    id: `n${String(seq)}`,
    method: 'POST',
    url: '/trpc/reports.submit',
    status: 200,
    ok: true,
    requestBody: JSON.stringify(requestBody),
    responseBody: JSON.stringify(responseBody),
  });
}

/** The act path, as far as the engine owns it. */
function verdictOf(events: ReticleEvent[]) {
  const predicate: Predicate = { kind: PredicateKind.TEXT, contains: SUBMITTED };
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(events, {
    action: 'click',
    actionSince: 0,
    prior: [],
    expectedFailures: declared.netFailures,
    namedNetUrls: declared.netUrls,
    repeatableNetUrls: declared.repeatableNetUrls,
    renderProved: declared.rendersContent,
    ...namedReactions(declared),
  });
  const decision = decideVerified({
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
  return { verified: decision.verified, kinds: contradictions.map((c) => c.kind) };
}

const shown = () => ev(EventType.DOM_TEXT, { text: SUBMITTED });

describe('a bumped optimistic-lock token is the proof of the write', () => {
  const bump = (key: string, from: unknown, to: unknown) =>
    write(
      { id: 'rep_1', title: 'Q3', [key]: from },
      { id: 'rep_1', title: 'Q3', [key]: to, status: SUBMITTED },
    );

  it.each(['version', 'lock_version', 'lockVersion', '__v', 'rowVersion', 'concurrencyStamp'])(
    'verifies `%s: 1 -> 2`',
    (key) => {
      expect(verdictOf([shown(), bump(key, 1, 2)])).toMatchObject({
        verified: Verified.YES,
        kinds: [],
      });
    },
  );

  it('verifies a lock token sent as a numeric string', () => {
    expect(verdictOf([shown(), bump('lock_version', '3', '4')]).verified).toBe(Verified.YES);
  });

  it('verifies an opaque concurrency stamp that the server replaced', () => {
    const before = '6f1c2a10-1111-4c2d-9a7e-0d4f5b6a7c80';
    const after = '9b3e7d22-2222-4f1a-8c6b-1e2d3c4b5a69';
    expect(verdictOf([shown(), bump('concurrencyStamp', before, after)]).verified).toBe(
      Verified.YES,
    );
  });

  it('still refuses a dropped field beside the version bump', () => {
    const events = [
      shown(),
      write(
        { id: 'rep_1', lock_version: 1, priority: 'high' },
        { id: 'rep_1', lock_version: 2, priority: 'normal' },
      ),
    ];
    expect(verdictOf(events).verified).toBe(Verified.NO);
  });

  it('still refuses a version-named field that is not a whole-number increase', () => {
    expect(verdictOf([shown(), bump('targetVersion', '1.4', '1.3')]).verified).toBe(Verified.NO);
  });

  it('still refuses a lock token that went down', () => {
    expect(verdictOf([shown(), bump('lock_version', 4, 3)]).verified).toBe(Verified.NO);
  });
});

/**
 * A burst on an endpoint the assertion never named must not decide that assertion (#673).
 *
 * An app that polls could not produce a verdict at all. A camera scan loop POSTing
 * `/api/people/match` until it acquired a lock had every `reticle_assert` and `act_and_wait` —
 * ones that had already seen the person recognised, the heading, the summary, the 200s — come back
 * `verified: "unknown" / evidence_incomplete`, because `duplicate-request` counted the loop's own
 * writes. The caller then reports `pass: true` with correct evidence and explains in prose that
 * Reticle's verdict is wrong, which erodes the reason to have a verdict.
 *
 * The steady-cadence half of that issue already landed. This is the other half: a poll that BURSTS,
 * a bursty analytics beacon, a retry loop — real findings, and not about the question asked.
 *
 * The named case keeps its downgrade. "The write you asked about fired twice" is what the rule is
 * for, and nothing here weakens it.
 */
import { describe, it, expect } from 'vitest';
import {
  ContradictionKind,
  EventType,
  FindingTier,
  isAdvisory,
  tierOfFinding,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/** Two writes close together — a burst, not a steady cadence, so the poll rule does not absorb it. */
function burst(url: string, at: number): ReticleEvent[] {
  return [at, at + 40].map(
    (t) =>
      ({
        type: EventType.NET_REQUEST,
        t,
        data: { method: 'POST', url, status: 200, ok: true },
      }) as unknown as ReticleEvent,
  );
}

const OPTS = { actionSince: 0, appOrigin: 'https://app.test/' };

function kinds(events: ReticleEvent[], options: Record<string, unknown>): string[] {
  return findContradictions(events, { ...OPTS, ...options }).map((c) => c.kind);
}

describe('a duplicate on an endpoint the assertion named still counts', () => {
  it('reports duplicate-request when the caller asked about that endpoint', () => {
    const found = kinds(burst('https://app.test/api/save', 10), {
      namedNetUrls: ['/api/save'],
    });
    expect(found).toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('treats a net clause with no urlContains as naming the whole channel', () => {
    // `{ kind: "net", method: "POST" }` asked about all traffic, so nothing is unrelated to it.
    const found = kinds(burst('https://app.test/api/save', 10), { namedNetUrls: [''] });
    expect(found).toContain(ContradictionKind.DUPLICATE_REQUEST);
  });
});

describe('a duplicate the assertion never named is a finding, not a verdict', () => {
  it('reports the unrelated kind instead', () => {
    const found = kinds(burst('https://app.test/api/people/match', 10), {
      namedNetUrls: ['/api/save'],
    });
    expect(found).toContain(ContradictionKind.DUPLICATE_REQUEST_UNRELATED);
    expect(found).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('still REPORTS it — nothing is hidden from the caller', () => {
    const found = findContradictions(burst('https://app.test/api/poll', 10), {
      ...OPTS,
      namedNetUrls: ['/api/save'],
    });
    const finding = found.find((c) => c.kind === ContradictionKind.DUPLICATE_REQUEST_UNRELATED);
    expect(finding?.detail, 'the endpoint and the count are still named').toContain('/api/poll');
    expect(finding?.counter).toContain('fired 2 times');
  });

  it('is tiered ADVISORY, so the verdict rule can drop it', () => {
    expect(isAdvisory(ContradictionKind.DUPLICATE_REQUEST_UNRELATED)).toBe(true);
    expect(tierOfFinding(ContradictionKind.DUPLICATE_REQUEST_UNRELATED)).toBe(FindingTier.ADVISORY);
  });

  it('leaves the named kind on its existing tier', () => {
    expect(isAdvisory(ContradictionKind.DUPLICATE_REQUEST)).toBe(false);
  });
});

describe('a caller who declared nothing gets the behaviour it had', () => {
  it('reports the plain kind when namedNetUrls is absent', () => {
    // A bare `observe` passes no predicate. With nothing declared, nothing is unrelated — inventing
    // a split there would silently downgrade a rule for callers this issue is not about.
    const found = kinds(burst('https://app.test/api/anything', 10), {});
    expect(found).toContain(ContradictionKind.DUPLICATE_REQUEST);
  });
});

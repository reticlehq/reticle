/**
 * `ui-advanced-request-failed` names the declaration that would exempt a designed failure (#1418).
 *
 * Testing a 402 paywall through the UI it renders gets this finding, and declaring the failing call
 * in the oracle is what exempts it. Nothing in the finding said so, so agents dropped the check or
 * weakened it until it proved nothing. The hint is built from the call itself and worded as a
 * condition; the finding and the verdict are unchanged.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '@/question/declared.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const domChanged = (): ReticleEvent => ev(EventType.DOM_ADDED, { path: 'div.paywall' });
const failedCall = (method: string, url: string, status?: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id: `n${String(seq)}`,
    method,
    url,
    ...(status === undefined ? {} : { status }),
    ok: false,
  });

const paywall = (): ReticleEvent[] => [
  domChanged(),
  failedCall('POST', 'http://localhost:3000/credits/unlock?plan=pro', 402),
];

const finding = (events: ReticleEvent[], expectedFailures = declaredExpectations(undefined)) =>
  findContradictions(events, {
    actionSince: 0,
    expectedFailures: expectedFailures.netFailures,
  }).find((c) => ContradictionKind.UI_ADVANCED_REQUEST_FAILED === c.kind);

describe('the hint on ui-advanced-request-failed', () => {
  it('names the method, path and status of the failed call, as a condition', () => {
    const detail = finding(paywall())?.detail ?? '';

    expect(detail).toContain('If this failure is the outcome you expect, declare it');
    expect(detail).toContain(
      '{"kind":"net","method":"POST","urlContains":"/credits/unlock","status":402}',
    );
  });

  it('is exactly the clause that clears the finding when declared', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.TEXT, contains: 'Upgrade to continue' },
        { kind: PredicateKind.NET, method: 'POST', urlContains: '/credits/unlock', status: 402 },
      ],
    });

    expect(finding(paywall(), declared)).toBeUndefined();
  });

  it('declares a failure with no status as ok: false', () => {
    const detail = finding([domChanged(), failedCall('PUT', '/api/profile')])?.detail ?? '';

    expect(detail).toContain(
      '{"kind":"net","method":"PUT","urlContains":"/api/profile","ok":false}',
    );
  });

  it('names every failed write when there is more than one', () => {
    const detail = finding([...paywall(), failedCall('DELETE', '/api/session', 429)])?.detail ?? '';

    expect(detail).toContain('If these failures are the outcome you expect');
    expect(detail).toContain('"urlContains":"/credits/unlock","status":402');
    expect(detail).toContain('"method":"DELETE","urlContains":"/api/session","status":429');
  });

  it('does not appear on a finding of another kind', () => {
    const others = findContradictions(paywall(), { actionSince: 0 }).filter(
      (c) => ContradictionKind.UI_ADVANCED_REQUEST_FAILED !== c.kind,
    );

    for (const other of others) expect(other.detail).not.toContain('declare it in the predicate');
  });
});

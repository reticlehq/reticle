/**
 * An agent's own malformed call was being reported as a defect in the user's app.
 *
 * Driven over real MCP against bench-app:
 *
 *   reticle_act_and_wait { until: { kind: 'state', path: 'nope.xyz', equals: 42 } }
 *   -> verified: "no", because: "the declared consequence did not hold",
 *      verdict.failureReason: "multiple stores (__reticle_renders, app, queries); name one with `store`"
 *
 * Nothing about the app failed. The call did not say WHICH store, so no assertion was ever
 * evaluated — and `verified: "no"` on that path emits `bug_found`. The headline metric therefore
 * counts agents mis-calling us as defects found in customer code, which is the one direction a
 * bug counter must never be wrong in.
 *
 * "Could not be judged" is what `verified: "unknown"` already means here (it is what a dirty capture
 * returns). So an under-specified assertion is UNKNOWN with the missing argument named, and emits
 * no bug.
 */

import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { buildHonestyBlock, HonestyGrade } from './honesty.js';
import { bugsInResult } from '../telemetry/bug-found.js';

const clean = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, attribution: 'window' });

describe('an assertion that could not be evaluated is not a failed assertion', () => {
  it('an under-specified call is UNKNOWN, not NO', () => {
    const d = decideVerified({
      pass: false,
      inconclusive: 'multiple stores (app, queries); name one with `store`',
      honesty: clean,
    });
    expect(d.verified).toBe(Verified.UNKNOWN);
    expect(d.because, 'the agent is told what to add').toContain('store');
  });

  it('and it outranks the failed-assertion clause, which would otherwise claim a defect', () => {
    // pass:false is the first clause in decideVerified precisely because a failure is the most
    // actionable fact. It is only the most actionable fact when there WAS a failure.
    expect(
      decideVerified({ pass: false, inconclusive: 'no registered store', honesty: clean }).because,
    ).not.toContain('did not hold');
  });

  it('a real failed assertion is untouched', () => {
    const d = decideVerified({ pass: false, honesty: clean });
    expect(d.verified).toBe(Verified.NO);
    expect(d.because).toContain('did not hold');
  });

  it('no bug is emitted for a verdict nobody could reach', () => {
    const inconclusive = {
      verified: Verified.UNKNOWN,
      verdict: { pass: false, inconclusive: 'multiple stores (app, queries)' },
    };
    expect(bugsInResult('reticle_act_and_wait', inconclusive)).toHaveLength(0);
    // ...and a genuine red still counts, or this fix would hide the metric it is protecting.
    expect(
      bugsInResult('reticle_act_and_wait', {
        verified: Verified.NO,
        verdict: { pass: false, assertion: 'route.changed' },
      }),
    ).toHaveLength(1);
  });
});

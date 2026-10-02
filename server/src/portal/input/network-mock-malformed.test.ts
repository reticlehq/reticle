/**
 * A mock rule that did not parse must not quietly become "turn mocking off".
 *
 * `toRules` ran the `mocks` array through `safeParse` and returned `[]` on failure. `[]` is not a
 * neutral value here — it is the documented way to CLEAR every active mock ("pass an empty array or
 * `clear: true` to turn mocking off"). So a rule with a wrong field name produced exactly the same
 * call as asking to stop mocking, and the handler reported `{ applied: true, count: 0 }`.
 *
 * What that costs is the whole point of the tool. `reticle_network_mock` exists to force error and
 * edge states — a failed payment, an offline request, a slow API. An agent that asks for a 500 and
 * is told `applied: true` proceeds to check the app's error handling against the REAL backend, sees
 * the happy path, and reports that the error state works. The one tell is `count: 0`, sitting beside
 * an `applied: true` that contradicts it.
 *
 * Two ways to get there, both easy: a plausible-but-wrong field name (`url`/`statusCode` rather than
 * `urlContains`/`status` — measured, this is what an agent reaches for first when the parameter list
 * describes `mocks` only as "Interception rules"), and one bad rule in an otherwise good array, which
 * discarded the good ones with it.
 *
 * This is the same defect that was fixed for actions: a valueless `fill` silently WIPED the field
 * and reported `ok: true`, and now throws. The rule there applies unchanged here — an argument that
 * could not be understood is refused by name, never reinterpreted into a destructive default.
 *
 * Clearing on purpose still works, by both documented routes: `clear: true`, and an explicit `[]`.
 */

import { describe, expect, it } from 'vitest';
import { toRules } from './network-mock-tools.js';

describe('a malformed mock rule is refused, not turned into a clear', () => {
  it('throws on a rule with the wrong field names', () => {
    // The exact shape reached for first: `url`/`statusCode` instead of `urlContains`/`status`.
    expect(() => toRules([{ url: '/api/login', statusCode: 500 }])).toThrow(/urlContains/);
  });

  it('names the tool and the offending rule, so the fix is in the message', () => {
    let message = '';
    try {
      toRules([{ url: '/api/login' }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('reticle_network_mock');
    // The reader has to learn it did NOT silently clear, because that is the thing they would
    // otherwise never find out.
    expect(message).toContain('mocking was left unchanged');
  });

  it('does not discard the good rules beside one bad rule', () => {
    // The old behaviour dropped BOTH, so a single typo disabled an entire mock set.
    expect(() => toRules([{ urlContains: '/api/pay', status: 500 }, { url: 'oops' }])).toThrow();
  });

  it('still accepts a well-formed set, with every optional field', () => {
    const rules = toRules([
      { urlContains: '/api/pay', method: 'POST', status: 500, body: '{}' },
      { urlContains: '/api/slow', delayMs: 2000 },
      { urlContains: '/api/gone', abort: true },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0]?.status).toBe(500);
    expect(rules[2]?.abort).toBe(true);
  });

  it('still treats an explicit empty array as a deliberate clear', () => {
    // The documented way to turn mocking off must keep working — this fix must not make `[]` an error.
    expect(toRules([])).toEqual([]);
  });

  it('treats an absent mocks argument as a clear, as before', () => {
    expect(toRules(undefined)).toEqual([]);
  });
});

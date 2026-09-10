/**
 * A `bodyContains` clause against a session that cannot record bodies should be refused BEFORE the
 * action, not after it.
 *
 * Reported: `act_and_wait` with `{ kind: "net", urlContains, bodyContains }` matched the right call
 * — "2 calls observed, 0 errors" — and returned `verified: "no"` with *"a matching call with no
 * recorded body"*, because that project's `connect()` does not pass `captureNetworkBodies`. The
 * reporter could not enable it: not their project's config to change for an unrelated verification
 * task. They fell back to a DOM text assertion, which is weaker evidence than the wire payload.
 *
 * The action was spent to learn something knowable in advance. On a drive that mutates state, an
 * action is not always repeatable — which is what makes this worth a pre-flight rather than a better
 * failure message.
 *
 * The asymmetry that governs every case here: refuse only on a DECLARED "off". An SDK too old to
 * announce the setting says nothing, and refusing on silence would break every session predating the
 * announcement for a clause many of them can satisfy.
 */

import { describe, expect, it } from 'vitest';
import { bodyClauseRefusal } from './body-capture-remedy.js';

const NET = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'net',
  urlContains: '/api/orders',
  bodyContains: 'confirmed',
  ...over,
});

describe('a body clause is refused before the action is spent', () => {
  it('refuses when the session has DECLARED body capture off', () => {
    const refusal = bodyClauseRefusal(NET(), { captureBodies: false });
    expect(refusal, 'the answer was knowable before the click').toBeTypeOf('string');
    expect(refusal).toContain('captureNetworkBodies');
  });

  it('does not refuse when capture is on', () => {
    expect(bodyClauseRefusal(NET(), { captureBodies: true })).toBeUndefined();
  });

  it('does not refuse when the SDK never said — silence is not a no', () => {
    // An SDK predating the announcement sends nothing. Refusing here would break every older session
    // for a clause many of them satisfy perfectly well.
    expect(bodyClauseRefusal(NET(), {})).toBeUndefined();
  });

  it('names the version instead of the setting when the SDK is too old to have it', () => {
    const refusal = bodyClauseRefusal(NET(), { captureBodies: false, sdkVersion: '2.1.0' });
    expect(refusal).toContain('2.1.0');
    expect(
      refusal,
      'the same rule as the post-hoc remedy — do not print an absent option',
    ).not.toContain('captureNetworkBodies');
  });

  it('ignores a predicate with no body clause', () => {
    expect(
      bodyClauseRefusal(NET({ bodyContains: undefined }), { captureBodies: false }),
    ).toBeUndefined();
  });

  it('sees a body clause nested inside allOf', () => {
    // The reported shape is an `allOf` — a route clause, a console clause, and the net clause that
    // needs bodies. Checking only the top level would miss every realistic call.
    const refusal = bodyClauseRefusal(
      { kind: 'allOf', predicates: [{ kind: 'route', pathname: '/x' }, NET()] },
      { captureBodies: false },
    );
    expect(refusal).toBeTypeOf('string');
  });

  it('sees requestBodyContains too', () => {
    const refusal = bodyClauseRefusal(
      NET({ bodyContains: undefined, requestBodyContains: 'sku-1' }),
      { captureBodies: false },
    );
    expect(refusal).toBeTypeOf('string');
  });
});

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findBodyFailures } from './body-failures.js';

const call = (status: number, responseBody: unknown, method = 'POST'): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method,
      url: '/api/bulk-hold',
      status,
      ...(responseBody === undefined ? {} : { responseBody: JSON.stringify(responseBody) }),
    },
  }) as unknown as ReticleEvent;

describe('failures reported inside a 2xx body', () => {
  it('reports per-item failures in a batch response', () => {
    const found = findBodyFailures([
      call(200, {
        requested: 3,
        results: [{ ok: true }, { ok: false, error: 'carrier_locked' }, { ok: true }],
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE);
    expect(found[0]?.counter).toContain('1 of 3');
  });

  it('reports a GraphQL error — always delivered as HTTP 200', () => {
    const found = findBodyFailures([
      call(200, { data: null, errors: [{ message: 'Field "x" not found' }] }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.counter).toContain('FAILED');
  });

  it('reports a gateway-normalised envelope', () => {
    expect(
      findBodyFailures([call(200, { success: false, message: 'insufficient funds' })]),
    ).toHaveLength(1);
  });

  it('stays silent when every item succeeded', () => {
    expect(findBodyFailures([call(200, { results: [{ ok: true }, { ok: true }] })])).toEqual([]);
  });

  it('stays silent on an explicit "no error" — null and empty are not failures', () => {
    expect(findBodyFailures([call(200, { error: null, errors: [], data: { id: 1 } })])).toEqual([]);
  });

  it('stays silent when the body was never captured', () => {
    expect(findBodyFailures([call(200, undefined)])).toEqual([]);
  });

  it('stays silent on a non-JSON body rather than guessing at prose', () => {
    const html = {
      type: EventType.NET_REQUEST,
      t: 10,
      data: { method: 'POST', url: '/x', status: 200, responseBody: '<html>error</html>' },
    } as unknown as ReticleEvent;
    expect(findBodyFailures([html])).toEqual([]);
  });

  it('ignores non-2xx — a 500 is already reported by every other rule', () => {
    expect(findBodyFailures([call(500, { errors: [{ message: 'boom' }] })])).toEqual([]);
  });

  it('walks a data array without tripping on GraphQL data objects', () => {
    // `data` is an item array here, and one row failed.
    expect(findBodyFailures([call(200, { data: [{ ok: true }, { ok: false }] })])).toHaveLength(1);
  });
});

/**
 * An error slot an API always sends and leaves EMPTY is the opposite of a failure.
 *
 * Reported from the field on a 200 from a page-data endpoint: the verdict came back
 * `contradicted` with "its body reports the operation FAILED", and the body's error container was
 * empty. `errors: []` was already read correctly; every other way of writing "none" was not, and
 * the reading that produced the accusation was the KEY being present rather than anything under it.
 */
describe('an empty error container is not a failure', () => {
  it('stays silent on an empty error MAP — the validation-envelope shape', () => {
    expect(findBodyFailures([call(200, { data: { id: 1 }, errors: {} }, 'GET')])).toEqual([]);
  });

  it('stays silent on an empty error object under the singular key', () => {
    expect(findBodyFailures([call(200, { data: { id: 1 }, error: {} }, 'GET')])).toEqual([]);
  });

  it('stays silent on `error: false` — the envelope flag that says there was none', () => {
    expect(
      findBodyFailures([call(200, { success: true, error: false, data: { id: 1 } }, 'GET')]),
    ).toEqual([]);
  });

  it('stays silent on a zero error code — 0 is how errno-style APIs spell "none"', () => {
    expect(findBodyFailures([call(200, { error: 0, data: { id: 1 } }, 'GET')])).toEqual([]);
  });

  it('stays silent on a whitespace-only message, as it already does on an empty one', () => {
    expect(findBodyFailures([call(200, { errorMessage: '   ', data: { id: 1 } }, 'GET')])).toEqual(
      [],
    );
  });

  it('reads an item the same way — the per-item walk shares the judgement', () => {
    expect(
      findBodyFailures([call(200, { results: [{ ok: true, error: false, errors: {} }] })]),
    ).toEqual([]);
  });

  // Negative controls: the detector that catches the false green must survive the fix.
  it('still reports a POPULATED error map', () => {
    const found = findBodyFailures([call(200, { errors: { email: ['already taken'] } })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE);
  });

  it('still reports a non-zero error code and a real message', () => {
    expect(findBodyFailures([call(200, { error: 42 })])).toHaveLength(1);
    expect(findBodyFailures([call(200, { errorMessage: 'carrier_locked' })])).toHaveLength(1);
  });

  it('still reports `error: true` — the flag saying there WAS one', () => {
    expect(findBodyFailures([call(200, { success: true, error: true })])).toHaveLength(1);
  });

  it('still reports a per-item failure standing beside empty error slots', () => {
    const found = findBodyFailures([
      call(200, {
        results: [
          { ok: true, errors: {} },
          { ok: false, error: 'carrier_locked' },
        ],
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.counter).toContain('1 of 2');
  });
});

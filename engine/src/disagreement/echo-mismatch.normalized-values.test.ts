/**
 * Two correct writes that were graded as dropped fields (#1646): the server stored the value and
 * echoed it in its own canonical spelling.
 *
 *  - a POST sent `qty: "18.5"` and a fixed-point column echoed `"18.500"`, the same decimal;
 *  - a POST sent `phone: "+1 555 010 0199"` and the server echoed `"+15550100199"`, the same number.
 *
 * A different value is still a dropped write, and so is a lost leading zero: a ZIP code `02134`
 * stored as `2134` is data loss, not formatting.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findEchoMismatches } from './echo-mismatch.js';

let seq = 0;
const write = (requestBody: unknown, responseBody: unknown): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: ++seq,
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: '/api/orders',
      status: 200,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

const ignored = (asked: unknown, echoed: unknown): boolean =>
  findEchoMismatches([write(asked, echoed)]).some(
    (c) => ContradictionKind.WRITE_FIELD_IGNORED === c.kind,
  );

describe('a value the server stored in its own spelling is not an ignored write', () => {
  it.each([
    ['18.5', '18.500'],
    ['1.0', '1'],
    ['2', '2.00'],
    ['-0.50', '-0.5'],
  ])('a decimal %s echoed as %s', (asked, echoed) => {
    expect(ignored({ qty: asked }, { qty: echoed })).toBe(false);
  });

  it('a decimal string echoed as the same JSON number', () => {
    expect(ignored({ qty: '18.50' }, { qty: 18.5 })).toBe(false);
  });

  it.each([
    ['+1 555 010 0199', '+15550100199'],
    ['(555) 010-0199', '5550100199'],
    ['555.010.0199', '555-010-0199'],
  ])('a phone number %s echoed as %s', (asked, echoed) => {
    expect(ignored({ phone: asked }, { phone: echoed })).toBe(false);
  });
});

describe('a value that changed is still an ignored write', () => {
  it.each([
    ['qty', '18.5', '18.6'],
    ['qty', '18.50', '1.85'],
    ['zip', '02134', '2134'],
    ['phone', '+1 555 010 0199', '+1 555 010 0198'],
    ['phone', '+1 555 010 0199', '1 555 010 0199'],
    ['code', '12-34', '1234'],
  ])('%s %s echoed as %s', (key, asked, echoed) => {
    expect(ignored({ [key]: asked }, { [key]: echoed })).toBe(true);
  });

  it('two long ids that differ only past the 15th digit', () => {
    expect(ignored({ ref: '123456789012345678' }, { ref: '123456789012345679' })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { ReticleEvent } from '@reticlehq/core';
import { sessionDelta, writeKeyOf } from './session-fold.js';

const req = (method: string, url: string): ReticleEvent =>
  ({ type: 'net.request', t: 1, data: { method, url } }) as unknown as ReticleEvent;

describe('writeKeyOf — one key per endpoint, not per record', () => {
  it('names a write by method and path, with ids collapsed', () => {
    expect(writeKeyOf(req('POST', 'http://h/api/orders/42/refund?x=1'))).toBe(
      'POST /api/orders/:id/refund',
    );
    expect(
      writeKeyOf(req('DELETE', 'http://h/api/items/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab')),
    ).toBe('DELETE /api/items/:id');
    expect(writeKeyOf(req('GET', 'http://h/api/orders'))).toBeUndefined();
  });
});

describe('sessionDelta', () => {
  it('turns one session into what it saw, touched, proved and wrote', () => {
    const delta = sessionDelta({
      seen: ['button "Add"', 'button "Pay"'],
      acted: ['button "Add"'],
      proved: ['button "Add"'],
      url: 'http://h/cart?x=1',
      events: [req('POST', 'http://h/api/cart'), req('GET', 'http://h/api/cart')],
    });
    expect(delta.controls).toEqual({
      seen: ['button "Add"', 'button "Pay"'],
      touched: ['button "Add"'],
      proved: ['button "Add"'],
    });
    expect(delta.routes?.reached).toEqual(['/cart']);
    expect(delta.writes?.seen).toEqual(['POST /api/cart']);
  });
});

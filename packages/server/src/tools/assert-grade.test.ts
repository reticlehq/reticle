import { describe, it, expect } from 'vitest';
import { isPresenceOnlyAssertion } from './assert-grade.js';
import type { Predicate } from '../events/predicate.js';

describe('isPresenceOnlyAssertion', () => {
  it('flags a bare element predicate', () => {
    expect(isPresenceOnlyAssertion({ kind: 'element', query: { role: 'button' } })).toBe(true);
  });

  it('flags a bare text predicate', () => {
    expect(isPresenceOnlyAssertion({ kind: 'text', contains: 'Saved' })).toBe(true);
  });

  it('does NOT flag a signal consequence', () => {
    expect(isPresenceOnlyAssertion({ kind: 'signal', name: 'order:placed' })).toBe(false);
  });

  it('does NOT flag a net consequence', () => {
    expect(isPresenceOnlyAssertion({ kind: 'net', urlContains: '/api/order', status: 200 })).toBe(
      false,
    );
  });

  it('does NOT flag presence when a consequence is allOf-ed in', () => {
    const p: Predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'element', query: { text: 'Done' } },
        { kind: 'signal', name: 'order:placed' },
      ],
    };
    expect(isPresenceOnlyAssertion(p)).toBe(false);
  });

  it('flags an allOf of only presence checks', () => {
    const p: Predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'element', query: { role: 'dialog' } },
        { kind: 'text', contains: 'Welcome' },
      ],
    };
    expect(isPresenceOnlyAssertion(p)).toBe(true);
  });

  it('does NOT flag non-presence predicates (route / settled / console)', () => {
    expect(isPresenceOnlyAssertion({ kind: 'route', pathname: '/success' })).toBe(false);
    expect(isPresenceOnlyAssertion({ kind: 'settled' })).toBe(false);
    expect(isPresenceOnlyAssertion({ kind: 'console', level: 'error', absent: true })).toBe(false);
  });

  it('flags a negated presence check (still presence-shaped)', () => {
    expect(
      isPresenceOnlyAssertion({
        kind: 'not',
        predicate: { kind: 'element', query: { text: 'x' } },
      }),
    ).toBe(true);
  });
});

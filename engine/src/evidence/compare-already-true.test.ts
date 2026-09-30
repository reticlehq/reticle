/**
 * A comparison between two LIVE readings can already agree before the action, and then its pass says
 * nothing about the action. It is checked before the act exactly as `text` and `state` are; a side
 * read from the event window is floored at the act's cursor, so it cannot be answered by the past.
 */
import { describe, it, expect } from 'vitest';
import { PredicateSchema } from '@reticlehq/core';
import { readsDomState } from './already-true.js';

const TEXT = { from: 'text', scope: '#total' };
const STATE = { from: 'state', path: 'cart.total' };
const NET = { from: 'net', urlContains: '/api/cart', path: 'total' };
const SIGNAL = { from: 'signal', name: 'cart:updated', path: 'total' };

const compare = (left: unknown, right: unknown) =>
  PredicateSchema.parse({ kind: 'compare', left, right });

describe('which comparisons are checked before the action', () => {
  it('checks one with a live side', () => {
    expect(readsDomState(compare(TEXT, STATE))).toBe(true);
    expect(readsDomState(compare(TEXT, NET))).toBe(true);
  });

  it('leaves one read entirely from the event window to its floor', () => {
    expect(readsDomState(compare(NET, SIGNAL))).toBe(false);
  });
});

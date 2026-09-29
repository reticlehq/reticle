/**
 * How a `compare` is read by everything that is not its evaluator: how a saved flow grades, which
 * channels it needs, and whether it can be saved at all.
 *
 * The expensive mistake here is the #811 one. A kind that is neither a consequence nor presence
 * grades a flow `assertion-free`, a permanent green wearing an assertion.
 */
import { describe, it, expect } from 'vitest';
import { flowExpectHasConsequence, flowExpectIsPresenceOnly } from '@/artifacts/flow-types.js';
import { ChannelId, channelsReadBy } from '@/wire/channel.js';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';
import { compareSourceClauses, sessionBoundField } from './predicate-tree.js';

const TEXT = { from: PredicateKind.TEXT, scope: '#total' } as const;
const NET = { from: PredicateKind.NET, urlContains: '/api/cart', path: 'total' } as const;

function compare(left: unknown, right: unknown): Predicate {
  return { kind: PredicateKind.COMPARE, left, right } as Predicate;
}

describe('a saved compare grades by what its sides read', () => {
  it('is a consequence when one side reads the app (net, signal, state)', () => {
    expect(flowExpectHasConsequence(compare(TEXT, NET))).toBe(true);
    expect(flowExpectIsPresenceOnly(compare(TEXT, NET))).toBe(false);
  });

  it('is presence when both sides read text, never assertion-free', () => {
    const both = compare(TEXT, { from: PredicateKind.TEXT, scope: '#summary' });
    expect(flowExpectHasConsequence(both)).toBe(false);
    expect(flowExpectIsPresenceOnly(both)).toBe(true);
  });
});

describe('a compare reads exactly the channels its sides name', () => {
  it('asks for ui and net for text against a response', () => {
    expect([...channelsReadBy(compare(TEXT, NET))].sort()).toEqual(
      [ChannelId.NET, ChannelId.UI].sort(),
    );
  });

  it('turns each side into the plain clause that reads it', () => {
    expect(
      compareSourceClauses(compare(TEXT, NET) as Extract<Predicate, { kind: 'compare' }>),
    ).toEqual([
      { kind: PredicateKind.TEXT, scope: '#total' },
      { kind: PredicateKind.NET, urlContains: '/api/cart' },
    ]);
  });
});

describe('a compare cannot be saved holding a session ref', () => {
  it('names the side whose scope is a ref', () => {
    expect(sessionBoundField(compare(NET, { from: PredicateKind.TEXT, scope: 'e12' }))).toBe(
      'compare.right.scope "e12"',
    );
    expect(sessionBoundField(compare(TEXT, NET))).toBeUndefined();
  });
});

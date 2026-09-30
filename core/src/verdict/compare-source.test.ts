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
import { sameCompareSource } from './compare-source.js';
import {
  FLOW_FILE_VERSION,
  READABLE_FLOW_VERSIONS,
  flowFileVersionFor,
} from '@/artifacts/flow-constants.js';
import { FlowFileSchema } from '@/artifacts/flow-types.js';

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

describe('a comparison with itself is refused whatever the method casing', () => {
  it('reads GET and get as the same source, as the network reader does', () => {
    expect(sameCompareSource({ ...NET, method: 'GET' }, { ...NET, method: 'get' })).toBe(true);
    expect(sameCompareSource({ ...NET, method: 'GET' }, { ...NET, method: 'POST' })).toBe(false);
  });
});

describe('a flow that uses compare is stamped so an older reader names the version', () => {
  // A reader from before `compare` knew versions 1 and 2 and answered PARSE_FAILED on the unknown
  // kind. A version it does not know gets "the reader is the wrong one" instead.
  const flow = (expect: unknown): { version: number } & Record<string, unknown> => ({
    version: FLOW_FILE_VERSION,
    name: 'refund',
    createdAt: 0,
    steps: [{ tool: 'reticle_act', anchor: { kind: 'testid', value: 'go' }, expect }],
  });

  it('stays at the base version without a compare', () => {
    expect(flowFileVersionFor(flow({ kind: PredicateKind.TEXT, contains: 'ok' }))).toBe(
      FLOW_FILE_VERSION,
    );
  });

  it('moves past every version an older reader knew when any clause compares, nested included', () => {
    const nested = flow({
      kind: PredicateKind.ALL_OF,
      predicates: [{ kind: PredicateKind.NOT, predicate: compare(TEXT, NET) }],
    });
    const version = flowFileVersionFor(nested);
    expect(version).toBeGreaterThan(FLOW_FILE_VERSION);
    expect(READABLE_FLOW_VERSIONS.has(version)).toBe(true);
    expect(FlowFileSchema.safeParse({ ...nested, version }).success).toBe(true);
  });

  it('keeps a v1 file at v1, and drops a file whose compare was removed back to the base', () => {
    expect(flowFileVersionFor({ ...flow(undefined), version: 1 })).toBe(1);
    expect(
      flowFileVersionFor({
        ...flow(undefined),
        version: flowFileVersionFor(flow(compare(TEXT, NET))),
      }),
    ).toBe(FLOW_FILE_VERSION);
  });

  it('finds a compare in success, requires and ensures too', () => {
    const base = flow(undefined);
    for (const where of ['success', 'requires', 'ensures']) {
      const at = 'success' === where ? compare(TEXT, NET) : [compare(TEXT, NET)];
      expect(flowFileVersionFor({ ...base, [where]: at })).toBeGreaterThan(FLOW_FILE_VERSION);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ChannelId } from './channel.js';
import type { Observation } from './evidence.js';
import { assertionsHeld, CountOp, evaluate, PredicateKind } from './predicate.js';

const at = (n: number, value: unknown, summary = 'net.request'): Observation => ({
  id: `o${String(n)}`,
  window: 'w1',
  channel: ChannelId.NET,
  at: n,
  value,
  summary,
});

const login = (n: number): Observation => at(n, { url: 'https://host/api/login', status: 200 });

describe('evaluating the predicate forms the specification names itself', () => {
  it('counts the matching observations and nothing else', () => {
    const observations = [login(1), login(2), at(3, { url: 'https://host/api/other' })];
    const twice = {
      kind: PredicateKind.COUNT,
      match: { channel: ChannelId.NET, summary: 'net.request', valueContains: '/api/login' },
      op: CountOp.EXACTLY,
      value: 1,
    };
    // The scenario this was built for: a claim naming one write, against a window holding two.
    expect(evaluate(twice, observations)).toBe(false);
    expect(evaluate(twice, [login(1)])).toBe(true);
  });

  it('does not match across channels, however well the value reads', () => {
    const elsewhere = [{ ...login(1), channel: ChannelId.UI }];
    const p = {
      kind: PredicateKind.PRESENT,
      match: { channel: ChannelId.NET, valueContains: '/api/login' },
    };
    // The channel is the whole basis of the independence rule. A predicate that quietly matched
    // an observation from another channel would let the subject's own reporting answer a claim
    // about the wire.
    expect(evaluate(p, elsewhere)).toBe(false);
    expect(evaluate(p, [login(1)])).toBe(true);
  });

  it('answers undefined for a predicate it does not speak, never false', () => {
    // The load-bearing case. An implementation's own language is not a failed claim, and reading
    // it as one would turn every unfamiliar predicate into a manufactured fault.
    expect(evaluate({}, [login(1)])).toBeUndefined();
    expect(evaluate({ kind: 'x-motor-rpm-below', value: 10 }, [login(1)])).toBeUndefined();
    expect(evaluate(undefined, [])).toBeUndefined();
  });

  it('treats absence as true over the window it was given, and only that', () => {
    const p = { kind: PredicateKind.ABSENT, match: { channel: ChannelId.NET } };
    expect(evaluate(p, [])).toBe(true);
    expect(evaluate(p, [login(1)])).toBe(false);
  });
});

describe('whether a claim held, three-valued', () => {
  const counted = {
    kind: PredicateKind.COUNT,
    match: { channel: ChannelId.NET, valueContains: '/api/login' },
    op: CountOp.EXACTLY,
    value: 1,
  };

  it('is undefined when nothing could be evaluated', () => {
    // "Nobody checked" must not collapse into either answer: as a pass it is a false green, and
    // as a failure it is a fault invented out of an implementation's vocabulary.
    expect(assertionsHeld([{ predicate: {} }, { predicate: {} }], [login(1)])).toBeUndefined();
    expect(assertionsHeld([], [login(1)])).toBeUndefined();
  });

  it('answers from the assertions it could evaluate, and any false decides', () => {
    const some = [{ predicate: counted }, { predicate: { kind: 'x-unknowable' } }];
    expect(assertionsHeld(some, [login(1)])).toBe(true);
    expect(assertionsHeld(some, [login(1), login(2)])).toBe(false);
  });
});

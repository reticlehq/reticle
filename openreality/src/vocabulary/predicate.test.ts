import { describe, expect, it } from 'vitest';
import { ChannelId } from './channel.js';
import type { Observation } from './evidence.js';
import {
  assertionsHeld,
  CountOp,
  MeasureOp,
  evaluate,
  MatchSchema,
  PredicateKind,
  PredicateSchema,
} from './predicate.js';

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
      match: { channel: ChannelId.NET, summary: 'net.request', valueContains: '/api/login' },
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
    match: { channel: ChannelId.NET, summary: 'net.request', valueContains: '/api/login' },
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

describe('a claim may not rest on valueContains alone', () => {
  /**
   * SPEC.md says this in the imperative and nothing enforced it, in a schema I wrote in the
   * same release as the sentence. The rule is real: rendering is an implementation's own, so an
   * unanchored substring can match in one conformant implementation and not in another, and a
   * claim hinging on it is not portable -- which is the one thing a published predicate form
   * exists to be.
   */
  it('refuses a match with valueContains and no summary', () => {
    expect(MatchSchema.safeParse({ channel: ChannelId.NET, valueContains: '/api/x' }).success).toBe(
      false,
    );
  });

  it('accepts it when anchored by an exact summary', () => {
    expect(
      MatchSchema.safeParse({
        channel: ChannelId.NET,
        summary: 'net.request',
        valueContains: '/api/x',
      }).success,
    ).toBe(true);
  });

  it('still accepts a match on the channel alone, which rests on nothing weak', () => {
    expect(MatchSchema.safeParse({ channel: ChannelId.NET }).success).toBe(true);
  });

  it('refuses it through the predicate too, not only the bare match', () => {
    // The schema a caller actually hands over is the predicate; a refinement that only held on
    // the inner shape would be satisfied by nobody's real input.
    expect(
      PredicateSchema.safeParse({
        kind: PredicateKind.PRESENT,
        match: { channel: ChannelId.NET, valueContains: '/api/x' },
      }).success,
    ).toBe(false);
  });
});

/**
 * A measured quantity, which is what every domain outside a browser actually claims about.
 *
 * The three existing forms answer "how many" and "was it there". Nothing answered "what was the
 * reading, and was it close enough": `count` takes a non-negative integer and counts MATCHES,
 * not values. So "the temperature held at 37 ± 0.5", "the arm reached 30.2° ± 0.5", "the frame
 * budget stayed under 16.7 ms", "the light drew at least 8 W" and "p99 latency was at most
 * 250 ms" were all inexpressible — biotechnology, physical AI, games, smart home and backends,
 * which between them is most of what this specification claims to serve.
 *
 * Deliberately one form rather than five domain-specific ones. A number means the same thing in
 * every domain; a `temperature` predicate would not, and the moment the vocabulary grows a
 * domain-shaped entry it stops being generic.
 *
 * `tolerance` is on every operator and defaults to zero, so there is no conditional requirement
 * to enforce — which matters here, because a `.refine()` would not survive the trip to JSON
 * Schema and this specification's rules must reach the implementer who never installs it.
 */
describe('a measured quantity, compared with a tolerance', () => {
  const reading = (n: unknown): Observation => ({
    id: 'o1',
    window: 'w1',
    channel: ChannelId.NET,
    at: 1,
    summary: 'sensor.temperature',
    value: n,
  });
  const measure = (op: MeasureOp, value: number, tolerance = 0): unknown => ({
    kind: PredicateKind.MEASURE,
    match: { channel: ChannelId.NET, summary: 'sensor.temperature' },
    op,
    value,
    tolerance,
  });

  it('accepts a reading inside the band and refuses one outside it', () => {
    expect(evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [reading(37.3)])).toBe(true);
    expect(evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [reading(37.6)])).toBe(false);
  });

  it('treats a zero tolerance as exact, which is the default', () => {
    expect(evaluate(measure(MeasureOp.EQUALS, 16), [reading(16)])).toBe(true);
    expect(evaluate(measure(MeasureOp.EQUALS, 16), [reading(16.0001)])).toBe(false);
  });

  it('widens at-least and at-most in the reading’s favour by the tolerance', () => {
    expect(evaluate(measure(MeasureOp.AT_LEAST, 8, 0.2), [reading(7.9)])).toBe(true);
    expect(evaluate(measure(MeasureOp.AT_LEAST, 8, 0.2), [reading(7.7)])).toBe(false);
    expect(evaluate(measure(MeasureOp.AT_MOST, 16.7, 0.3), [reading(16.9)])).toBe(true);
    expect(evaluate(measure(MeasureOp.AT_MOST, 16.7, 0.3), [reading(17.1)])).toBe(false);
  });

  it('says NOBODY CHECKED when the matched observation carries no number', () => {
    // Not false. A realm that reports its temperature as the string "37C" has not been
    // evaluated, and reading that as a failed claim would invent a defect out of a formatting
    // choice. Same three-valued discipline as an unparseable predicate.
    expect(evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [reading('37C')])).toBeUndefined();
    expect(evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [reading(Number.NaN)])).toBeUndefined();
  });

  it('says NOBODY CHECKED when nothing matched at all', () => {
    // Distinct from `absent`, which asserts emptiness on purpose. A measurement over no reading
    // is not a reading of zero.
    expect(evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [])).toBeUndefined();
  });

  it('is satisfied by any one matching reading, the way present is', () => {
    expect(
      evaluate(measure(MeasureOp.EQUALS, 37, 0.5), [reading(40), reading(37.1), reading(12)]),
    ).toBe(true);
  });

  it('refuses a negative tolerance, which would narrow rather than widen', () => {
    expect(evaluate(measure(MeasureOp.EQUALS, 37, -1), [reading(37)])).toBeUndefined();
  });
});

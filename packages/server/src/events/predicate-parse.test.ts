/**
 * A raw zod array must never reach the agent.
 *
 * Measured on 2026-08-10: **9 of the 58 tool errors recorded that day — 16% — were a serialized zod
 * issue array**, and every one landed on `reticle_act_and_wait` (4), `reticle_wait_for` (4) or
 * `reticle_assert` (1). Those are precisely the three tools that produced every action-derived
 * finding in the dataset, so the least readable error we emit lands on the highest-value path.
 *
 * What the agent got, redacted by the telemetry pipeline:
 *
 *   [ { *: *, *: [ * ], *: [], *: * } ]
 *
 * Unredacted it is `[{"code":"invalid_type","expected":"object","path":[],"message":"..."}]` — an
 * agent has to JSON.parse an error string to learn which field it got wrong, and it spends tokens on
 * a structure nobody reads. #108 asks for one shape across all argument mistakes: a sentence naming
 * the parameter, whether anything ran, and a valid example.
 */

import { describe, expect, it } from 'vitest';
import { parsePredicate } from './predicate-parse.js';

const messageOf = (input: unknown): string => {
  try {
    parsePredicate(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected parsePredicate to reject');
};

describe('parsePredicate turns a zod rejection into a sentence', () => {
  it('never emits a JSON array', () => {
    const message = messageOf({ kind: 'route', pathnmae: '/checkout' });
    expect(message.trimStart().startsWith('['), `got a raw dump: ${message}`).toBe(false);
    expect(message).not.toContain('"code"');
    expect(message).not.toContain('invalid_type');
  });

  it('names the offending key so the agent knows what to change', () => {
    expect(messageOf({ kind: 'route', pathnmae: '/checkout' })).toContain('pathnmae');
  });

  it('names the kind it was trying to parse', () => {
    expect(messageOf({ kind: 'route', pathnmae: '/x' })).toContain('route');
  });

  it('says nothing ran, because an argument rejection means exactly that', () => {
    expect(messageOf({ kind: 'signal', naem: 'x' })).toMatch(/nothing ran|was not evaluated/i);
  });

  it('carries a valid example the agent can copy', () => {
    expect(messageOf({ kind: 'nope' })).toContain('kind');
  });

  it('still parses a good predicate untouched, aliases included', () => {
    expect(parsePredicate({ kind: 'route', path: '/checkout' })).toMatchObject({
      kind: 'route',
      pathname: '/checkout',
    });
  });
});

describe('the error describes a nested field, not just its name', () => {
  /*
   * The three calls from the field report on #445, in order. Each was correctly rejected and none
   * of them said what `query` wanted, so the agent guessed three times and produced no verdict.
   */
  const WRONG_FLAT = { kind: 'element', selector: '#journeyScreen.active iframe' };
  const WRONG_STRING = { kind: 'element', query: '#journeyScreen.active iframe' };
  const WRONG_NESTED_KEY = { kind: 'element', query: { css: '#journeyScreen.active iframe' } };

  it.each([
    ['a flat selector', WRONG_FLAT],
    ['a string where an object goes', WRONG_STRING],
    ['a key that is nobody spelling of a query field', WRONG_NESTED_KEY],
  ])('names the shape of query when the mistake is %s', (_label, input) => {
    const message = messageOf(input);
    expect(message, `no query shape in: ${message}`).toContain('query accepts:');
    // `role` and `testid` are the two an agent reaches for first; if the expansion ever silently
    // returns [] the sentence still reads fine, so assert on contents rather than the phrase alone.
    expect(message).toContain('role');
    expect(message).toContain('testid');
  });

  it('still names the top-level fields it always did', () => {
    expect(messageOf(WRONG_STRING)).toContain('element accepts:');
  });

  it('does not drag in a nested shape the caller did not get wrong', () => {
    // `net` has no object-valued field, so nothing should be expanded for it. Guards against a
    // version that expands every field of every kind and buries the answer in noise.
    const message = messageOf({ kind: 'net', urlContainz: '/api/save' });
    expect(message).toContain('net accepts:');
    expect(message).not.toContain('accepts: by,');
  });
});

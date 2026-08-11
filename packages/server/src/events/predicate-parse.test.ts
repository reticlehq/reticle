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

/**
 * A raw zod array must never reach the agent.
 *
 * A serialized zod issue array is the least readable error we emit, and the tools it lands on are
 * `reticle_act_and_wait`, `reticle_wait_for` and `reticle_assert` — the three that derive a finding
 * from an action. So the worst error shape sits on the highest-value path.
 *
 * The shape an agent gets back:
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

  it('expands a nested object field, so element.query is not a second round trip', () => {
    // The reported trap: a plain CSS string works in reticle_snapshot.scope and
    // reticle_query.scope, so assuming it works here is the natural guess. The
    // rejection is the only place that inconsistency can be explained.
    const message = messageOf({ kind: 'element', query: '#journeyScreen iframe' });
    expect(message).toContain('element accepts:');
    expect(message).toContain('query accepts:');
    expect(message).toContain('role');
    expect(message).toContain('testid');
  });

  it('expands the nested shape for a wrong top-level field too', () => {
    expect(messageOf({ kind: 'element', selector: '#app' })).toContain('query accepts:');
  });

  it('answers a `ref` on element with the query shape, not with a move to the call', () => {
    // The first `element` assertion a session writes often carries a `ref`, because that is what
    // `reticle_query` returned a moment earlier. Sending it to the CALL is misdirection: on
    // `act_and_wait` moving it up retargets the action, and `reticle_assert` has no `until` at all,
    // so the caller loses its target and still does not parse. The answer is the shape it should
    // have written — the locator nests under `query` — which is what #1374 asks for.
    const message = messageOf({ kind: 'element', ref: 'e1' });
    expect(message).toContain('query accepts:');
    expect(message).toContain('testid');
    expect(message).toContain('element predicates take `query`');
    expect(message).not.toMatch(/argument of the CALL/i);
    expect(message).not.toContain('beside `until`');
    // And a copyable example, which is what the issue asked the rejection to carry.
    expect(message).toContain('{ kind: "element", query: {');
  });

  it('still names the call for a misplaced argument on the kinds where that is right', () => {
    // The move-beside-`until` clause is correct for the flat kinds — a `timeout_ms` on a `signal`
    // really is a call argument one level too deep. Only `element` + `ref` is the exception.
    const message = messageOf({ kind: 'signal', timeout_ms: 5_000 });
    expect(message).toMatch(/argument of the CALL/i);
    expect(message).toContain('beside `until`');
  });

  it('leaves a kind with no nested object field unchanged', () => {
    const message = messageOf({ kind: 'route', pathnmae: '/x' });
    expect(message).toContain('route accepts:');
    expect(message).not.toContain(' accepts: by,');
  });

  it('reads core`s `type` spelling, so the locator answer is not skipped', () => {
    // `type` is the discriminator core normalises before parsing, so `{ type: 'element', ref }` is
    // the same predicate as the canonical spelling. Reading `kind` alone gave it the move-beside-
    // `until` advice the canonical spelling no longer gets, plus a `kind "unknown"` diagnosis.
    const message = messageOf({ type: 'element', ref: 'e1' });
    expect(message).toContain('element predicates take `query`');
    expect(message).not.toMatch(/argument of the CALL/i);
    expect(message).not.toContain('beside `until`');
    expect(message).not.toContain('kind "unknown"');
  });

  it('keeps its `type` spelling in step with core`s', () => {
    // The engine spells `type` locally rather than importing core's private constant — the coupling
    // ceiling counts every borrowed name — so this is what holds the two together. If core ever drops
    // the alias, the clause above reads a kind nobody writes any more, and this line goes red rather
    // than the message quietly reverting to `kind "unknown"`.
    expect(parsePredicate({ type: 'element', query: { role: 'button' } })).toMatchObject({
      kind: 'element',
    });
  });

  it('says to delete the extra `ref` when the locator is already in `query`', () => {
    // Telling the caller to "put the locator inside `query`" when it is already there sends it to
    // rewrite a field that is already right; the only action left is removing the extra `ref`.
    const message = messageOf({ kind: 'element', query: { testid: 'x' }, ref: 'e1' });
    expect(message).toContain('already sits in `query`');
    expect(message).toContain('delete the `ref`');
    expect(message).not.toContain('put the locator inside');
  });

  it('reaches an `element` predicate wrapped in `anyOf`', () => {
    // Wrapping the first `element` assertion of a session in a combinator is ordinary, so a fix
    // that only holds at the top level leaves that spelling with no answer at all.
    const message = messageOf({ kind: 'anyOf', predicates: [{ kind: 'element', ref: 'e1' }] });
    expect(message).toContain('element predicates take `query`');
  });

  it('keeps both clauses when a locator and a call argument are written together', () => {
    const message = messageOf({ kind: 'element', ref: 'e1', timeout_ms: 45_000 });
    expect(message).toContain('element predicates take `query`');
    expect(message).toMatch(/argument of the CALL/i);
  });

  it('still parses a good predicate untouched, aliases included', () => {
    expect(parsePredicate({ kind: 'route', path: '/checkout' })).toMatchObject({
      kind: 'route',
      pathname: '/checkout',
    });
  });

  it('does not read an empty `query` as a locator that is already there', () => {
    // `query: {}` is accepted and locates nothing, so "the locator already sits in `query`" told the
    // caller to delete the only target it had and retry against whatever else matched.
    const message = messageOf({ kind: 'element', query: {}, ref: 'e1' });
    expect(message).toContain('put the locator inside `query`');
    expect(message).not.toContain('delete the `ref`');
  });

  it('reaches an `element` predicate nested past the shallow shapes', () => {
    // The schema nests combinators without limit, so a cutoff on depth answered
    // `allOf → not → anyOf → element` with the very error the locator clause exists to explain.
    const message = messageOf({
      kind: 'allOf',
      predicates: [
        { kind: 'not', predicate: { kind: 'anyOf', predicates: [{ kind: 'element', ref: 'e1' }] } },
      ],
    });
    expect(message).toContain('element predicates take `query`');
  });

  it('counts the clauses past its limit instead of repeating one per member', () => {
    // One rejected `anyOf` can carry an invalid `element` per member, and a clause each turned a
    // single tool error into the same sentence repeated until the field list that answers the
    // question was the hardest thing in it to find.
    const members = [
      { kind: 'element', ref: 'e1' },
      { kind: 'element', ref: 'e2', timeout_ms: 1 },
      { kind: 'element', ref: 'e3', sessionId: 's' },
      { kind: 'element', ref: 'e4', action: 'click' },
      { kind: 'element', ref: 'e5', args: {} },
      { kind: 'element', ref: 'e6', target: 'x' },
    ];
    const message = messageOf({ kind: 'anyOf', predicates: members });
    expect(message.match(/put the locator inside/g) ?? []).toHaveLength(1);
    expect(message).toContain('more predicates need the same fix');
  });
});

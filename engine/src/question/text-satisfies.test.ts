/**
 * `satisfies` on a `text` predicate.
 *
 * `state { satisfies }` exists because a generated value's exact bytes differ every run and are
 * right every time. The same is true of the place a user actually SEES that value — the DOM — and
 * until now the only thing a `text` predicate could say about it was `contains`, which is the one
 * assertion a model's output cannot satisfy twice.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult, type ElementDescriptor } from '@reticlehq/core';
import { evaluatePredicate } from '@/question/predicate/predicate.js';
import { parsePredicate } from '@/question/predicate/predicate-parse.js';
import type { PredicateSession } from '@/question/predicate/predicate-session.js';

const el = (text: string): ElementDescriptor =>
  ({ ref: 'e1', role: 'generic', name: '', text }) as ElementDescriptor;

function pageShowing(elements: ElementDescriptor[]): PredicateSession {
  return {
    id: 's1',
    url: 'http://localhost/compose',
    elapsed: () => 0,
    eventsSince: () => [],
    command: (name: string): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result:
          name === ReticleCommand.MATCH
            ? { matched: elements.length > 0, count: elements.length, elements }
            : {},
      } as CommandResult),
  } as unknown as PredicateSession;
}

const textSatisfies = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'text',
  scope: '[data-testid="compose-result"]',
  self: true,
  ...over,
});

describe('text { satisfies } — assert a PROPERTY of what is on screen', () => {
  it('parses a text predicate that carries only `satisfies`', () => {
    expect(() =>
      parsePredicate(textSatisfies({ satisfies: { property: 'nonEmpty' } })),
    ).not.toThrow();
  });

  it('passes when the rendered text has the property', async () => {
    const result = await evaluatePredicate(
      pageShowing([el('Deploy pipeline now runs 30% faster.')]),
      parsePredicate(textSatisfies({ satisfies: { property: 'nonEmpty' } })),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  // The failure a generative feature actually has: the box rendered and there is nothing in it.
  it('fails when the element rendered empty, and says what it saw', async () => {
    const result = await evaluatePredicate(
      pageShowing([el('   ')]),
      parsePredicate(textSatisfies({ satisfies: { property: 'nonEmpty' } })),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.failureReason).toContain('empty result');
  });

  it('applies the property to the text, not to the element count', async () => {
    const result = await evaluatePredicate(
      pageShowing([el('99 deploys')]),
      parsePredicate(
        textSatisfies({ satisfies: { property: 'matchesPattern', pattern: '^\\d+ deploys$' } }),
      ),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  // `satisfies` narrows, it never excuses — the same rule `state` already holds.
  it('requires BOTH when `contains` is supplied alongside it', async () => {
    const both = parsePredicate(
      textSatisfies({
        contains: 'Paris',
        satisfies: { property: 'matchesPattern', pattern: 'capital' },
      }),
    );
    expect(
      (await evaluatePredicate(pageShowing([el('Paris is a city')]), both, 0, false)).pass,
    ).toBe(false);
    expect(
      (await evaluatePredicate(pageShowing([el('Paris is the capital')]), both, 0, false)).pass,
    ).toBe(true);
  });

  /*
   * A predicate that asserts nothing must never parse. `{kind:'text'}` with neither `contains` nor
   * `satisfies` would resolve to "some element, any text" and pass on every page that has one —
   * the bare-predicate false green, arriving through the door `contains` becoming optional opens.
   */
  it('refuses a text predicate that asserts neither', () => {
    expect(() => parsePredicate({ kind: 'text' })).toThrow();
  });

  /*
   * `satisfies` alone has no subject without a scope: the locator would be "every element on the
   * page", and the property would run against whatever the first match happened to be. Refused
   * rather than guessed — an unevaluatable predicate must say so, never resolve to an accident.
   */
  it('refuses `satisfies` with no scope to read the text of', () => {
    expect(() => parsePredicate({ kind: 'text', satisfies: { property: 'nonEmpty' } })).toThrow();
  });
});

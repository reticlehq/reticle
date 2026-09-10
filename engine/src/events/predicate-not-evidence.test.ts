/**
 * A passing `not` must SHOW what it checked.
 *
 * Reported from an agent session as "the element predicate's `text` filter is ignored inside `not` —
 * three different `text` values return byte-identical evidence". The filter is in fact honoured (the
 * first test below pins that), but the green branch of `not` returns a bare `{ pass: true }`: no
 * evidence, no subject, nothing that names the predicate that failed to hold. So a negation over a
 * text that was genuinely absent and a negation the tool silently dropped are indistinguishable in
 * the response, and the only reading available to the caller is the wrong one.
 *
 * Every other absence path already carries something — `element` with `absent: true` returns
 * `evidence: { absent: true }` (and `{ absent, scopeMissing }` when the scope was gone). `not` is the
 * one green that proves nothing about itself.
 */
import { describe, it, expect } from 'vitest';
import {
  asRef,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import { parsePredicate } from './predicate-parse.js';

function el(over: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    ref: asRef('r1'),
    role: 'alert',
    name: 'Payment failed',
    text: 'Payment failed',
    states: [],
    visible: true,
    ...over,
  };
}

/** Emulates the browser locator's precedence: role wins, a text-only query matches on substring. */
class DomSession implements PredicateSession {
  readonly seen: ElementQuery[] = [];
  constructor(private readonly elements: readonly ElementDescriptor[]) {}
  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const query = (args['query'] ?? {}) as ElementQuery;
    if (ReticleCommand.MATCH === name) this.seen.push(query);
    const wantedText = query.text;
    const hits =
      query.role !== undefined
        ? this.elements.filter((element) => element.role === query.role)
        : wantedText === undefined
          ? [...this.elements]
          : this.elements.filter((element) => (element.text ?? element.name).includes(wantedText));
    const result: MatchResult = { matched: hits.length > 0, count: hits.length, elements: hits };
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

describe('negated element predicate', () => {
  it('honours the text filter inside not', async () => {
    const session = new DomSession([el()]);
    const held = await evaluatePredicate(
      session,
      parsePredicate({ kind: 'not', predicate: { kind: 'element', text: 'Payment failed' } }),
    );
    const absent = await evaluatePredicate(
      session,
      parsePredicate({ kind: 'not', predicate: { kind: 'element', text: 'Refund issued' } }),
    );
    expect(held.pass, 'the negated text IS on the page').toBe(false);
    expect(absent.pass, 'the negated text is NOT on the page').toBe(true);
    expect(session.seen.map((query) => query.text)).toEqual(['Payment failed', 'Refund issued']);
  });

  it('reports what it negated on a green, so two different texts are not the same answer', async () => {
    const session = new DomSession([el()]);
    const first = await evaluatePredicate(
      session,
      parsePredicate({ kind: 'not', predicate: { kind: 'element', text: 'Refund issued' } }),
    );
    const second = await evaluatePredicate(
      session,
      parsePredicate({ kind: 'not', predicate: { kind: 'element', text: 'Zebra unicorn' } }),
    );
    expect(first.pass).toBe(true);
    expect(second.pass).toBe(true);
    expect(
      first.evidence,
      'a green negation must carry evidence of what did not hold',
    ).toBeDefined();
    expect(
      JSON.stringify(first),
      'two different negated texts must not produce byte-identical results',
    ).not.toBe(JSON.stringify(second));
  });
});

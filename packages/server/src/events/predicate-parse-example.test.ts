import { describe, it, expect } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { parsePredicate } from './predicate-parse.js';

/**
 * When a predicate is rejected, the example offered has to be of the kind that FAILED.
 *
 * It was always `{ kind: "signal", name: "todos:loaded" }`, whatever went wrong. Watched on a real
 * drive: an agent guessed the `element` shape wrong, was shown a `signal` example, guessed `element`
 * wrong again, and was shown the same `signal` example. Two round trips, and a rejected predicate
 * produces no verdict at all — so the cost is not just the retries, it is a drive that ends with
 * nothing.
 *
 * The field list was already correct. The example was the part still saying something true about
 * another kind.
 */
function messageFor(input: unknown): string {
  try {
    parsePredicate(input);
    throw new Error('expected the predicate to be rejected');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('a rejected predicate is shown an example of its OWN kind', () => {
  it('offers an element example when element was the kind that failed', () => {
    // The exact shape from the field report: `ref` is not an element field, and the element locator
    // lives nested under `query`, which is the part worth showing.
    const message = messageFor({ kind: PredicateKind.ELEMENT, ref: 'e3', value: '1187.01' });
    expect(message).toContain('unknown field ref');
    expect(message).toContain(`kind: "${PredicateKind.ELEMENT}"`);
    expect(message).toContain('query');
    expect(message).not.toContain('todos:loaded');
  });

  it('offers a net example when net was the kind that failed', () => {
    const message = messageFor({ kind: PredicateKind.NET, nope: 1 });
    expect(message).toContain(`kind: "${PredicateKind.NET}"`);
    expect(message).toContain('urlContains');
    expect(message).not.toContain('todos:loaded');
  });

  it('offers a text example when text was the kind that failed', () => {
    const message = messageFor({ kind: PredicateKind.TEXT, nope: 1 });
    expect(message).toContain(`kind: "${PredicateKind.TEXT}"`);
    expect(message).toContain('contains');
    expect(message).not.toContain('todos:loaded');
  });

  it('still names the accepted fields alongside the example', () => {
    // The example shows one valid shape; the field list is what says which OTHER fields exist. Losing
    // either one sends the caller back for a second guess.
    const message = messageFor({ kind: PredicateKind.NET, nope: 1 });
    expect(message).toContain('net accepts:');
    expect(message).toContain('bodyContains');
  });

  it('falls back to a generic example when the KIND itself is the mistake', () => {
    // No kind means no per-kind example to offer, and the accepted-kinds list is the real answer here.
    const message = messageFor({ kind: 'nonsense' });
    expect(message).toContain('is not a predicate kind');
  });
});

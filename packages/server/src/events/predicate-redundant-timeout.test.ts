/**
 * A predicate that carries the timeout the enclosing call already carries is accepted, not refused.
 *
 * From the field:
 *
 *   reticle_act_and_wait { until: { kind: "element", query: {...}, timeout_ms: 30000 } }
 *   -> "that predicate did not parse (kind \"element\"): unknown field timeout_ms; ..."
 *
 * The reporter called that error good — it is precise and it names the accepted fields. The
 * complaint is that they had to provoke it, and a rejected predicate produces NO verdict, so the
 * round trip ended with nothing. The call already carries `timeout_ms` and it means exactly the
 * same thing, so refusing buys nothing (#877).
 *
 * The boundary matters as much as the tolerance. #744 deliberately made unknown keys loud in flow
 * `expect`/`success` blocks: a flow file is a saved contract and a live call is not. Flow files
 * validate through `PredicateSchema` directly, so they are untouched here — pinned below.
 */

import { describe, expect, it } from 'vitest';
import { parsePredicate } from './predicate-parse.js';
import { PredicateSchema } from './predicate.js';
import { PredicateKind } from '@reticlehq/core';

describe('a redundant timeout inside a live predicate', () => {
  it('is accepted, where it used to end the call with no verdict', () => {
    const parsed = parsePredicate({
      kind: PredicateKind.ELEMENT,
      query: { role: 'button', name: 'Save' },
      timeout_ms: 30_000,
    });

    expect(parsed.kind).toBe(PredicateKind.ELEMENT);
  });

  it('is dropped rather than carried, so nothing downstream can read it as a real field', () => {
    const parsed = parsePredicate({
      kind: PredicateKind.TEXT,
      contains: 'Saved',
      timeout_ms: 30_000,
    });

    expect(parsed).not.toHaveProperty('timeout_ms');
  });

  it('accepts the camelCase spelling too', () => {
    expect(
      parsePredicate({ kind: PredicateKind.TEXT, contains: 'Saved', timeoutMs: 500 }).kind,
    ).toBe(PredicateKind.TEXT);
  });

  it('is tolerated inside a combinator member, for the same reason', () => {
    const parsed = parsePredicate({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.TEXT, contains: 'Saved', timeout_ms: 1000 },
        { kind: PredicateKind.CONSOLE, level: 'error', absent: true },
      ],
    });

    expect(parsed.kind).toBe(PredicateKind.ALL_OF);
  });

  it('is tolerated inside not, which nests one predicate rather than a list', () => {
    const parsed = parsePredicate({
      kind: PredicateKind.NOT,
      predicate: { kind: PredicateKind.TEXT, contains: 'Error', timeout_ms: 1000 },
    });

    expect(parsed.kind).toBe(PredicateKind.NOT);
  });
});

describe('the tolerance does not become a general shrug', () => {
  it('still refuses a field that would change behaviour', () => {
    expect(() =>
      parsePredicate({ kind: PredicateKind.TEXT, contains: 'Saved', selector: '.toast' }),
    ).toThrow(/unknown field selector/);
  });

  it('still reports the real mistake when a timeout rides along with one', () => {
    // Stripping must not swallow the error the agent actually needs to read.
    expect(() =>
      parsePredicate({ kind: PredicateKind.TEXT, contains: 'Saved', timeout_ms: 1, nope: 1 }),
    ).toThrow(/unknown field nope/);
  });

  it('leaves an unknown KIND unknown', () => {
    expect(() => parsePredicate({ kind: 'elementt', timeout_ms: 1 })).toThrow(
      /not a predicate kind/,
    );
  });
});

describe('a saved flow contract stays loud (#744)', () => {
  it('still rejects the same key when validated as a flow expect block', () => {
    // Flow files go through PredicateSchema directly, which is the seam this tolerance sits above.
    const result = PredicateSchema.safeParse({
      kind: PredicateKind.TEXT,
      contains: 'Saved',
      timeout_ms: 30_000,
    });

    expect(result.success).toBe(false);
  });
});

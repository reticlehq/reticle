import { describe, expect, it } from 'vitest';
import { parsePredicate } from './predicate-parse.js';

/**
 * A property assertion survives PARSING and arrives at the evaluator.
 *
 * The schema and the switch that consumes it live in different files, and this repo has already
 * paid for that gap twice: `act_sequence` refused every `expect` it had learned to grade, because
 * a door written before the grader existed still listed it as ungradeable — so the whole graded
 * path was unreachable from the live surface while every unit test passed, because every unit test
 * called the grader directly. And a malformed `expect` was silently counted as "nothing declared".
 *
 * So this asserts the SEAM, not the logic: `satisfies` parses, keeps its shape, and is refused
 * loudly when it is malformed rather than dropped into a predicate that then asserts nothing.
 */
describe('a property assertion reaches the predicate', () => {
  it('parses `satisfies` on a state predicate and keeps every field', () => {
    const pred = parsePredicate({
      kind: 'state',
      path: 'summary',
      satisfies: { property: 'nonEmpty' },
    }) as { kind: string; path: string; satisfies?: { property: string } };
    expect(pred.kind).toBe('state');
    expect(pred.path).toBe('summary');
    expect(pred.satisfies?.property).toBe('nonEmpty');
  });

  it('carries the arguments of a parameterised property', () => {
    const pred = parsePredicate({
      kind: 'state',
      path: 'total',
      satisfies: { property: 'withinTolerance', of: 100, tolerance: 5 },
    }) as { satisfies?: Record<string, unknown> };
    expect(pred.satisfies).toEqual({ property: 'withinTolerance', of: 100, tolerance: 5 });
  });

  it('REFUSES an unknown property instead of dropping it', () => {
    // Dropping it would leave `{kind:'state', path}` — a predicate that passes on any value the
    // path holds. An agent that asked for a check would be told it got one.
    expect(() =>
      parsePredicate({ kind: 'state', path: 'summary', satisfies: { property: 'looksGoodToMe' } }),
    ).toThrow();
  });

  it('REFUSES a property whose arguments are missing', () => {
    expect(() =>
      parsePredicate({
        kind: 'state',
        path: 'total',
        satisfies: { property: 'withinTolerance', of: 100 },
      }),
    ).toThrow();
  });

  it('still accepts a plain equality predicate — nothing existing had to change', () => {
    const pred = parsePredicate({ kind: 'state', path: 'view', equals: 'overview' }) as {
      equals?: unknown;
    };
    expect(pred.equals).toBe('overview');
  });
});

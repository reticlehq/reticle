/**
 * #2291: a chat repeats one heading in every answer, so a `text` check for it was already true
 * before the action and `act_and_wait` could not wait for the next answer. `count` on `text` asks
 * for exactly N matching elements, as `count` does on `net` and `signal`.
 */
import { describe, expect, it } from 'vitest';
import {
  PredicateSchema,
  ReticleCommand,
  type CommandResult,
  type MatchResult,
  type Predicate,
} from '@reticlehq/core';

import { evaluatePredicate, waitForPredicate, type PredicateSession } from './predicate.js';
import { declaredExpectations } from '../declared.js';

/** A page whose MATCH answers with `copies()` matches, read again on every call. */
function pageWith(copies: () => number, extra: Partial<MatchResult> = {}): PredicateSession {
  return {
    command(name: string): Promise<CommandResult> {
      if (name !== ReticleCommand.MATCH) {
        throw new Error(`unexpected command ${name}`);
      }
      const count = copies();
      const result: MatchResult = { matched: count > 0, count, elements: [], ...extra };
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

/** Start of the refusal `checkPredicateShape` gives, so a test cannot pass on another error. */
const COUNT_REFUSAL = '`count` on a text predicate cannot be combined';

const answers = (count: number): Predicate => ({ kind: 'text', contains: 'Answer', count });

describe('a text check with a count', () => {
  it('fails on one copy and passes on two, the issue case', async () => {
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 1),
          answers(2),
        )
      ).pass,
    ).toBe(false);
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 2),
          answers(2),
        )
      ).pass,
    ).toBe(true);
  });

  it('says how many it saw and how many it wanted', async () => {
    const result = await evaluatePredicate(
      pageWith(() => 1),
      answers(2),
    );
    expect(result.failureReason).toContain('expected exactly 2');
    expect(result.failureReason).toContain('saw 1');
    expect(result.assertion).toBe('text.count');
  });

  // On `net` an over-count is final, because a window of events only grows. Copies on a page can
  // be removed again by a re-render, so three is not the last word on a check that wants two.
  it('fails on too many copies without calling it decided', async () => {
    const result = await evaluatePredicate(
      pageWith(() => 3),
      answers(2),
    );
    expect(result.pass).toBe(false);
    expect(result.decided).toBeUndefined();
  });

  it('reads count 0 as the absence it is', async () => {
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 0),
          answers(0),
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 1),
          answers(0),
        )
      ).pass,
    ).toBe(false);
  });

  it('leaves a check without a count passing on the first copy, as before', async () => {
    const plain: Predicate = { kind: 'text', contains: 'Answer' };
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 3),
          plain,
        )
      ).pass,
    ).toBe(true);
  });

  it('waits for the second copy to arrive', async () => {
    let reads = 0;
    const result = await waitForPredicate(
      pageWith(() => (++reads > 3 ? 2 : 1)),
      answers(2),
      2_000,
    );
    expect(result.pass).toBe(true);
    expect(reads).toBeGreaterThan(3);
  });
});

/**
 * The hold after a count first holds. On `net` a failing second reading is an over-count and final,
 * because events only add up. Copies on a page come and go, so a reading taken during a re-render
 * between two states must send the wait back to polling, not end it red with time left.
 */
describe('the hold on a text count', () => {
  /** Copies over time: 1, then 2, then `between` while the page re-renders, then 2 for good. */
  const settling = (between: number): (() => number) => {
    const start = Date.now();
    return () => {
      const t = Date.now() - start;
      if (t < 200) {
        return 1;
      }
      if (t < 400) {
        return 2;
      }
      return t < 700 ? between : 2;
    };
  };

  it.each([
    ['a dip to one copy', 1],
    ['a spike to three copies', 3],
  ])('waits past %s and passes when the page settles at two', async (_name, between) => {
    const result = await waitForPredicate(pageWith(settling(between)), answers(2), 5_000);
    expect(result.pass).toBe(true);
  });

  it('still fails a count the page never settles at', async () => {
    const result = await waitForPredicate(
      pageWith(() => 3),
      answers(2),
      800,
    );
    expect(result.pass).toBe(false);
    expect(result.failureReason).toContain('saw 3');
  });
});

/**
 * With no element whose own text holds the phrase, the page answers with the one tightest element
 * whose visible text does, and reports `count: 1` however many split copies there are. That number
 * is not a count of copies, so a count is not judged on it.
 */
describe('a phrase split across child elements', () => {
  it('is inconclusive for a count, rather than a pass on one or a miss on two', async () => {
    const split = pageWith(() => 1, { splitOwner: true });
    for (const want of [1, 2]) {
      const result = await evaluatePredicate(split, answers(want));
      expect(result.pass).toBe(false);
      expect(result.inconclusive).toContain('split across child elements');
    }
  });

  it('still passes a check without a count, which only asks for the phrase', async () => {
    const plain: Predicate = { kind: 'text', contains: 'Answer' };
    expect(
      (
        await evaluatePredicate(
          pageWith(() => 1, { splitOwner: true }),
          plain,
        )
      ).pass,
    ).toBe(true);
  });
});

/** An older page never sends `splitOwner`, so its `count: 1` may stand for several split copies. */
describe('a text count on a page whose SDK predates splitOwner', () => {
  const on = (sdkVersion: string, copies: number): PredicateSession => ({
    ...pageWith(() => copies),
    sdkVersion,
  });

  it('is inconclusive and names both versions', async () => {
    const result = await evaluatePredicate(on('3.10.11', 1), answers(1));
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('3.10.11');
    expect(result.inconclusive).toContain('3.10.12');
  });

  it('is judged from the first SDK that sends it', async () => {
    expect((await evaluatePredicate(on('3.10.12', 1), answers(1))).pass).toBe(true);
  });

  it('leaves a check without a count, and count 0, as they were', async () => {
    const plain: Predicate = { kind: 'text', contains: 'Answer' };
    expect((await evaluatePredicate(on('3.10.11', 1), plain)).pass).toBe(true);
    expect((await evaluatePredicate(on('3.10.11', 0), answers(0))).pass).toBe(true);
  });
});

describe('the text count in the schema', () => {
  it('accepts a whole number with contains', () => {
    expect(PredicateSchema.parse(answers(2))).toEqual(answers(2));
  });

  it.each([-1, 1.5])('refuses %s', (count) => {
    expect(PredicateSchema.safeParse(answers(count)).success).toBe(false);
  });

  it('refuses count with absent, which would say two things about one number', () => {
    const both = { kind: 'text', contains: 'Answer', count: 2, absent: true };
    expect(JSON.stringify(PredicateSchema.safeParse(both).error?.issues)).toContain(COUNT_REFUSAL);
  });

  it('refuses count with satisfies, which would leave open what is counted', () => {
    const both = {
      kind: 'text',
      contains: 'Answer',
      count: 2,
      satisfies: { property: 'nonEmpty' },
    };
    expect(JSON.stringify(PredicateSchema.safeParse(both).error?.issues)).toContain(COUNT_REFUSAL);
  });
});

describe('what a text count declares', () => {
  it('declares rendered content for one or more copies, and not for count 0', () => {
    expect(declaredExpectations(answers(2)).rendersContent).toBe(true);
    expect(declaredExpectations(answers(0)).rendersContent).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { EventType, ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';

import { evaluatePredicate, waitForPredicate, type PredicateSession } from './predicate.js';
import type { EvalResult, Predicate } from './predicate-eval.js';

/**
 * #1656. A check expected `POST /api/auth/login` to answer 401, and it answered 500. A text clause
 * in the same `allOf` timed out on a slow page. The verdict was `unknown`, and its `because` was
 * "the page did not answer: command 'match' timed out". That sentence comes from the wait's catch:
 * `allOf` read its clauses with `Promise.all`, so one read that threw rejected the whole conjunction
 * and the net clause's real failure was lost.
 */

/** The message a real Session gives when the page does not answer a MATCH in time. */
const MATCH_TIMEOUT = "command 'match' timed out after 3546ms";

/** A session whose page records network events but cannot answer a page read. */
class SlowPageSession implements PredicateSession {
  constructor(private readonly events: ReticleEvent[]) {}

  elapsed(): number {
    return 0;
  }

  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) {
      return Promise.reject(new Error(MATCH_TIMEOUT));
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): ReticleEvent[] {
    return this.events.filter((e) => e.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function netEvent(status: number): ReticleEvent {
  return {
    t: 1,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: { method: 'POST', url: '/api/auth/login', status },
  };
}

/** The issue's page: one settled POST that answered 500. */
const answered500 = (): SlowPageSession => new SlowPageSession([netEvent(500)]);

const expects401: Predicate = {
  kind: 'net',
  method: 'POST',
  urlContains: '/api/auth/login',
  status: 401,
};
const expects500: Predicate = { ...expects401, status: 500 };
const errorText: Predicate = { kind: 'text', contains: 'Invalid email or password' };
const otherText: Predicate = { kind: 'text', contains: 'Signed in' };

/** The clause results a composite keeps as its evidence. */
function clauseResults(result: EvalResult): EvalResult[] {
  return Array.isArray(result.evidence) ? (result.evidence as EvalResult[]) : [];
}

describe('a composite clause whose read throws (#1656)', () => {
  it('allOf: a net status miss beside a timed-out text read waits to a plain no', async () => {
    // The reported case, through the wait that the tools call.
    const result = await waitForPredicate(
      answered500(),
      { kind: 'allOf', predicates: [expects401, errorText] },
      50,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
    expect(result.failureReason).not.toContain(MATCH_TIMEOUT);
  });

  it('allOf: the clause that could not be read keeps its reason in the evidence', async () => {
    // Rule 11: the `no` names the net failure, and the thrown reason is not dropped.
    const result = await evaluatePredicate(answered500(), {
      kind: 'allOf',
      predicates: [expects401, errorText],
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
    const unread = clauseResults(result).find((r) => r.inconclusive !== undefined);
    expect(unread?.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
    expect(unread?.failureReason).toBe(MATCH_TIMEOUT);
  });

  it('allOf: every clause throws, so it is inconclusive and names the thrown reason', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'allOf',
      predicates: [errorText, otherText],
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });

  it('allOf: a clause that passed does not hide one nobody could read', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'allOf',
      predicates: [expects500, errorText],
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });

  it('anyOf: a clause that passed is enough, even when its sibling throws', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'anyOf',
      predicates: [errorText, expects500],
    });
    expect(result.pass).toBe(true);
  });

  it('anyOf: a failed clause beside one that threw is inconclusive, not a no', async () => {
    // The unread clause might have been the one that matched, so anyOf cannot say "none matched".
    const result = await evaluatePredicate(answered500(), {
      kind: 'anyOf',
      predicates: [errorText, expects401],
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });

  it('a nested composite that threw does not reject its parent', async () => {
    const result = await waitForPredicate(
      answered500(),
      {
        kind: 'allOf',
        predicates: [
          { kind: 'anyOf', predicates: [errorText, otherText] },
          { kind: 'not', predicate: otherText },
          expects401,
        ],
      },
      50,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('a lone clause that throws still ends as inconclusive with its reason', async () => {
    // Unchanged: no composite, so the wait's own catch answers.
    const result = await waitForPredicate(answered500(), errorText, 50);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });
});

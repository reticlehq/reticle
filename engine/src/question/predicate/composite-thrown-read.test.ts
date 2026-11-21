import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventType, ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';

import {
  evaluatePredicate,
  provenExpectedLinks,
  waitForPredicate,
  type PredicateSession,
} from './predicate.js';
import { predicateToExpectedLinks } from './predicate-to-links.js';
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
  /** How many MATCH reads the page was sent. */
  reads = 0;

  constructor(
    private readonly events: ReticleEvent[],
    /** A text that the page CAN read, and finds. Every other read throws. */
    private readonly readable?: string,
  ) {}

  elapsed(): number {
    return 0;
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) {
      this.reads += 1;
      if (this.readable !== undefined && JSON.stringify(args).includes(this.readable)) {
        const element = { ref: 'e1', role: 'status', name: this.readable, text: this.readable };
        const result = { matched: true, count: 1, elements: [element] };
        return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
      }
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
    // `readError` is for the wait itself. The tool schemas do not declare it.
    expect(result).not.toHaveProperty('readError');
  });

  it('keeps the exact message of the read that threw, for the caller to act on', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'allOf',
      predicates: [errorText, otherText],
    });
    expect(result.readError).toBe(MATCH_TIMEOUT);
  });

  it('a composite with a clause that failed carries no read error', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'allOf',
      predicates: [expects401, errorText],
    });
    expect(result.readError).toBeUndefined();
  });
});

/** Every key anywhere inside a value, so a nested `readError` cannot hide. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysDeep);
  }
  if ('object' !== typeof value || null === value) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
}

describe('readError stays out of what the agent reads (#1656)', () => {
  it('no clause in a composite evidence carries readError, at any depth', async () => {
    const session = answered500();
    const shapes: Predicate[] = [
      { kind: 'allOf', predicates: [expects401, errorText] },
      { kind: 'allOf', predicates: [errorText, otherText] },
      { kind: 'anyOf', predicates: [expects401, errorText] },
      { kind: 'not', predicate: { kind: 'allOf', predicates: [errorText, otherText] } },
      {
        kind: 'allOf',
        predicates: [{ kind: 'anyOf', predicates: [errorText, otherText] }, expects401],
      },
    ];
    for (const shape of shapes) {
      const result = await evaluatePredicate(session, shape);
      expect(keysDeep(result.evidence)).not.toContain('readError');
    }
  });

  it('the composite itself keeps readError, so the wait can end on it', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'not',
      predicate: { kind: 'allOf', predicates: [errorText, otherText] },
    });
    expect(result.readError).toBe(MATCH_TIMEOUT);
  });
});

describe('a composite wait that is unknown because a read threw ends at once (#1656)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start a long wait and report whether it has ended, without letting the budget run. */
  function startWait(session: SlowPageSession, predicate: Predicate) {
    const state: { result: EvalResult | undefined } = { result: undefined };
    void waitForPredicate(session, predicate, 30_000).then((r) => {
      state.result = r;
    });
    return state;
  }

  it('allOf of two reads that throw ends at the first read, as on main', async () => {
    // Before, one throw rejected the composite and the wait ended. The per-clause catch must not
    // turn that into a wait that runs the whole budget for the same unknown.
    const session = answered500();
    const state = startWait(session, { kind: 'allOf', predicates: [errorText, otherText] });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result?.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
    expect(session.reads).toBe(2);
  });

  it('allOf of a clause that passes and a read that throws ends at the first read', async () => {
    const session = new SlowPageSession([netEvent(500)], 'Signed in');
    const state = startWait(session, { kind: 'allOf', predicates: [otherText, errorText] });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result === undefined ? undefined : clauseResults(state.result)[0]?.pass).toBe(
      true,
    );
    expect(state.result?.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
    expect(session.reads).toBe(2);
  });

  it('anyOf of a clause that failed and a read that throws ends at the first read', async () => {
    const session = answered500();
    const state = startWait(session, { kind: 'anyOf', predicates: [expects401, errorText] });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result?.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
    expect(session.reads).toBe(1);
  });

  it('a read that throws in a nested composite ends the wait at the first read', async () => {
    const session = answered500();
    const nested: Predicate = {
      kind: 'allOf',
      predicates: [{ kind: 'anyOf', predicates: [errorText, otherText] }, expects500],
    };
    const state = startWait(session, nested);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result?.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
    expect(state.result).not.toHaveProperty('readError');
    expect(session.reads).toBe(2);
  });

  it('allOf with a clause that failed keeps waiting, and gives no at the end of the budget', async () => {
    const state = startWait(answered500(), { kind: 'allOf', predicates: [expects401, errorText] });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.result?.pass).toBe(false);
    expect(state.result?.inconclusive).toBeUndefined();
  });
});

describe('not of a composite with a read that threw (#1656)', () => {
  it('not(allOf[fail, throw]) passes: the allOf failed, so its negation holds', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'not',
      predicate: { kind: 'allOf', predicates: [expects401, errorText] },
    });
    expect(result.pass).toBe(true);
  });

  it('not(allOf[pass, throw]) is inconclusive: the allOf could not be read', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'not',
      predicate: { kind: 'allOf', predicates: [expects500, errorText] },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });

  it('not(anyOf[fail, throw]) is inconclusive: the unread clause could have matched', async () => {
    const result = await evaluatePredicate(answered500(), {
      kind: 'not',
      predicate: { kind: 'anyOf', predicates: [expects401, errorText] },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(`the page did not answer: ${MATCH_TIMEOUT}`);
  });
});

describe('provenExpectedLinks for an anyOf with a branch whose read throws (#1656)', () => {
  it('keeps the link of the branch that passed, and drops the branch that threw', async () => {
    // A green anyOf[net passes, text throws] is reachable now. The re-read of each branch must not
    // reject: that turned a green verdict into a tool error.
    const links = await provenExpectedLinks(answered500(), {
      kind: 'anyOf',
      predicates: [expects500, errorText],
    });
    expect(links).toEqual(predicateToExpectedLinks(expects500));
  });

  it('drops a branch that is unknown because a read threw, even when it has a link', async () => {
    // The allOf branch has the same net link, so keeping it would list that link twice.
    const links = await provenExpectedLinks(answered500(), {
      kind: 'anyOf',
      predicates: [expects500, { kind: 'allOf', predicates: [errorText, expects500] }],
    });
    expect(links).toEqual(predicateToExpectedLinks(expects500));
  });
});

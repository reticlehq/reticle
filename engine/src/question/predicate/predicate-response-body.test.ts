/**
 * A substring of a KEY NAME is not a statement about a field's value (#987).
 *
 * Reported from the field, and the only false GREEN in that export: an agent asserted
 * `net { bodyContains: "completed" }` against a job endpoint and got `verified: "yes"` for a job
 * whose status was `queued`. The needle matched inside the key `completedAt`, which was `null`.
 *
 * Every other verdict defect in that export fails CLOSED — an unknown, a refusal, a contradiction.
 * This one passed something untrue, which is the one failure this product cannot absorb.
 *
 * The trap is easy to walk into because `bodyContains` is the natural reach for exactly the
 * assertion it cannot make: an enum state in a JSON response. `completed`/`completedAt`,
 * `success`/`successRate`, `active`/`inactive`, `sent`/`unsent` — the narrower the state, the more
 * likely some adjacent key already carries it as a substring.
 */
import { describe, it, expect } from 'vitest';
import { EventType, REDACTED_VALUE, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import { bodyClauseRefusal } from '@/evidence/body-capture-remedy.js';

function netEvent(data: Record<string, unknown>): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'GET',
      url: 'https://app.test/api/jobs/7',
      status: 200,
      ok: true,
      ...data,
    },
  } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  constructor(private readonly events: readonly ReticleEvent[]) {}
  command(): Promise<never> {
    return Promise.reject(new Error('no element commands in these tests'));
  }
  eventsSince(): ReticleEvent[] {
    return [...this.events];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 100;
  }
}

const FILTER = { kind: 'net', urlContains: '/api/jobs' } as const;

/** The reported body: the job is queued, and `completed` is only ever part of a key name. */
const QUEUED = '{"id":7,"status":"queued","completedAt":null}';

async function judge(event: Record<string, unknown>, clause: Record<string, unknown>) {
  return evaluatePredicate(new WindowSession([netEvent(event)]), { ...FILTER, ...clause });
}

describe('a needle found only inside a key name decides nothing', () => {
  it('does not pass "completed" against a queued job', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyContains: 'completed' });
    expect(r.pass, 'the job was queued; this is the reported false green').toBe(false);
  });

  it('is undecidable rather than a failure, and names the key it hit', async () => {
    // Not a red either: the substring IS in the body. What is false is reading that as a verdict on
    // a value, so the honest answer is "this proves nothing", not "the app is broken".
    const r = await judge({ responseBody: QUEUED }, { bodyContains: 'completed' });
    expect(r.inconclusive).toBeDefined();
    expect(r.inconclusive).toContain('completedAt');
    expect(r.failureReason).toBeUndefined();
  });

  it('names the assertion that WOULD answer the question', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyContains: 'completed' });
    expect(r.inconclusive).toContain('bodyMatches');
  });
});

describe('the ordinary substring meaning is untouched', () => {
  it('still passes when the needle is a whole key — "this field is in the response"', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyContains: 'completedAt' });
    expect(r.pass).toBe(true);
  });

  it('still passes when the needle is in a VALUE, key collision or not', async () => {
    const done = '{"id":7,"status":"completed","completedAt":"2026-09-01"}';
    const r = await judge({ responseBody: done }, { bodyContains: 'completed' });
    expect(r.pass).toBe(true);
  });

  it('still passes on a key:value span, which belongs to neither half alone', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyContains: '"status":"queued"' });
    expect(r.pass).toBe(true);
  });

  it('leaves a non-JSON body alone — nothing here can tell a key from a word', async () => {
    const r = await judge(
      { responseBody: 'job 7 not completed yet' },
      { bodyContains: 'completed' },
    );
    expect(r.pass).toBe(true);
  });

  it('still fails when the needle is absent altogether', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyContains: 'running' });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('the response value is what differed');
  });
});

describe('bodyMatches is the field assertion bodyContains was being misread as', () => {
  it('fails when the field holds a different value', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyMatches: { status: 'completed' } });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('queued');
  });

  it('passes when it holds the declared one', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyMatches: { status: 'queued' } });
    expect(r.pass).toBe(true);
  });

  it('cannot be satisfied by a key name, whatever the key is called', async () => {
    const r = await judge({ responseBody: QUEUED }, { bodyMatches: { status: 'completedAt' } });
    expect(r.pass).toBe(false);
  });

  it('ignores key order and whitespace, which a substring cannot', async () => {
    const r = await judge(
      { responseBody: '{\n  "completedAt": null,\n  "status": "queued"\n}' },
      { bodyMatches: { status: 'queued' } },
    );
    expect(r.pass).toBe(true);
  });

  it('reads the RESPONSE only, so a value the app merely SENT cannot satisfy it', async () => {
    const r = await judge(
      { requestBody: '{"status":"completed"}', responseBody: QUEUED },
      { bodyMatches: { status: 'completed' } },
    );
    expect(r.pass).toBe(false);
  });

  it('says a redacted field is unknown, not different', async () => {
    const r = await judge(
      { responseBody: `{"token":"${REDACTED_VALUE}"}` },
      { bodyMatches: { token: 'abc' } },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('REDACTED');
    expect(r.failureReason).toBeUndefined();
  });
});

describe('every body clause is refused up front when the session records no bodies', () => {
  it('covers the two field-level clauses, not only the two substring ones', () => {
    // `requestBodyMatches` was already missing from that list: a predicate carrying only it spent an
    // action to learn what was knowable before the action ran.
    for (const clause of [
      { bodyMatches: { status: 'queued' } },
      { requestBodyMatches: { a: 1 } },
    ]) {
      expect(bodyClauseRefusal({ ...FILTER, ...clause }, { captureBodies: false })).toBeDefined();
    }
  });
});

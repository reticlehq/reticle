import { describe, it, expect } from 'vitest';
import {
  EventType,
  PredicateKind,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evalNet, type Predicate } from './predicate-eval.js';
import { STATUS_MISS_HOLD_MS } from './net-status-miss.js';
import { waitForPredicate, type PredicateSession } from './predicate.js';

/**
 * #1656. A check expects `POST /api/auth/login` to answer 401, and the server answers 500.
 *
 * The net clause used to report "no matching call" and was never final. When another clause of the
 * same `allOf` then timed out on a slow page, the verdict was `unknown`, although the evidence
 * already showed that the expected status did not come. The clause is now decided false when every
 * settled call to that method and URL has another status, none is in flight, and none has started
 * for STATUS_MISS_HOLD_MS after the last answer.
 */
const LOGIN = '/api/auth/login';
const POST = 'POST';
const EXPECTED_STATUS = 401;
const OBSERVED_STATUS = 500;
const ANSWERED_AT = 100;
const AFTER_HOLD = ANSWERED_AT + STATUS_MISS_HOLD_MS;
const WITHIN_HOLD = ANSWERED_AT + 100;
/** A wait budget that no test run reaches, so only a decided clause ends the wait. */
const WAIT_BUDGET_MS = 600_000;
const TEST_TIMEOUT_MS = 20_000;

const expect401: Extract<Predicate, { kind: typeof PredicateKind.NET }> = {
  kind: PredicateKind.NET,
  method: POST,
  urlContains: LOGIN,
  status: EXPECTED_STATUS,
};

function pending(t: number, id: string): ReticleEvent {
  return { type: EventType.NET_PENDING, t, sessionId: 's', data: { id, method: POST, url: LOGIN } };
}

function answered(t: number, id: string, status: number | undefined): ReticleEvent {
  const data: Record<string, unknown> = { id, method: POST, url: LOGIN };
  if (status !== undefined) {
    data['status'] = status;
    data['ok'] = status < 400;
  }
  return { type: EventType.NET_REQUEST, t, sessionId: 's', data };
}

/** One login request that started and answered 500. */
const ONE_500 = [pending(50, 'n1'), answered(ANSWERED_AT, 'n1', OBSERVED_STATUS)];

describe('a settled call with another status decides the net clause (#1656)', () => {
  it('decides false when the only call answered 500 and nothing is in flight', () => {
    const r = evalNet(ONE_500, expect401, undefined, AFTER_HOLD);
    expect(r.pass).toBe(false);
    expect(r.decided).toBe(true);
    expect(r.inconclusive).toBeUndefined();
    expect(r.failureReason).toContain(String(OBSERVED_STATUS));
    expect(r.failureReason).toContain(String(EXPECTED_STATUS));
  });

  it('does not decide while a second request to the same endpoint is in flight', () => {
    const events = [...ONE_500, pending(AFTER_HOLD - 10, 'n2')];
    const r = evalNet(events, expect401, undefined, AFTER_HOLD + 10);
    expect(r.pass).toBe(false);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not decide before the hold ends, and asks for a check when it does', () => {
    // An app that retries at once sends the second request a few milliseconds after the first
    // answer. Its start can reach the bridge after the answer, so a decision at once could end the
    // wait before a retry that answers 401.
    const r = evalNet(ONE_500, expect401, undefined, WITHIN_HOLD);
    expect(r.decided ?? false).toBe(false);
    expect(r.retryAfterMs).toBe(AFTER_HOLD - WITHIN_HOLD);
  });

  it('measures the hold from the LAST answer to that endpoint', () => {
    const events = [...ONE_500, pending(150, 'n2'), answered(400, 'n2', OBSERVED_STATUS)];
    const r = evalNet(events, expect401, undefined, AFTER_HOLD);
    expect(r.decided ?? false).toBe(false);
  });

  it('passes when a retry answers the expected status', () => {
    const events = [...ONE_500, pending(150, 'n2'), answered(400, 'n2', EXPECTED_STATUS)];
    const r = evalNet(events, expect401, undefined, AFTER_HOLD + 400);
    expect(r.pass).toBe(true);
  });

  it('does not decide without a clock', () => {
    const r = evalNet(ONE_500, expect401);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not decide when a call to that endpoint carried no readable status', () => {
    const events = [...ONE_500, pending(60, 'n2'), answered(90, 'n2', undefined)];
    const r = evalNet(events, expect401, undefined, AFTER_HOLD);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not decide when no call to that endpoint was seen', () => {
    const r = evalNet([], expect401, undefined, AFTER_HOLD);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not decide when a pending record carries no id, because it cannot be paired', () => {
    const unkeyed: ReticleEvent = {
      type: EventType.NET_PENDING,
      t: 120,
      sessionId: 's',
      data: { method: POST, url: LOGIN },
    };
    const r = evalNet([...ONE_500, unkeyed], expect401, undefined, AFTER_HOLD);
    expect(r.decided ?? false).toBe(false);
  });

  it('ignores calls to other endpoints, settled or in flight', () => {
    const other: ReticleEvent = {
      type: EventType.NET_PENDING,
      t: 120,
      sessionId: 's',
      data: { id: 'n9', method: 'GET', url: '/api/me' },
    };
    const r = evalNet([...ONE_500, other], expect401, undefined, AFTER_HOLD);
    expect(r.decided).toBe(true);
  });
});

/** Events from an array; every MATCH answers "not found", as on a page that never shows the text. */
function sessionAt(events: ReticleEvent[], now: number): PredicateSession {
  return {
    command: (name): Promise<CommandResult> => {
      const result =
        ReticleCommand.MATCH === name ? { matched: false, count: 0, elements: [] } : {};
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    },
    eventsSince: (cursor = 0) => events.filter((e) => e.t >= cursor),
    onEvent: () => () => undefined,
    elapsed: () => now,
  };
}

describe('allOf with a decided status miss ends the wait with no (#1656)', () => {
  it(
    'ends the wait with a decided failure instead of spending the budget',
    async () => {
      // The budget is far longer than this test's timeout, so the test fails if the wait does not end.
      const result = await waitForPredicate(
        sessionAt(ONE_500, AFTER_HOLD),
        {
          kind: PredicateKind.ALL_OF,
          predicates: [expect401, { kind: PredicateKind.TEXT, contains: 'Welcome back' }],
        },
        WAIT_BUDGET_MS,
      );
      expect(result.pass).toBe(false);
      expect(result.decided).toBe(true);
      expect(result.inconclusive).toBeUndefined();
      expect(result.failureReason).toContain(String(OBSERVED_STATUS));
    },
    TEST_TIMEOUT_MS,
  );
});

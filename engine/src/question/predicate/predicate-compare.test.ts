/**
 * `compare`: two observed values related to each other, with no expected value written down.
 *
 * The refund case is the one that shipped: a refund posted `{"amount":"1187.01"}`, the server read
 * it as paise and answered `{"refunded":11.87}`, and the page displayed the number the user had
 * typed. Request fired, status 200, console clean, page settled — every channel green. A
 * `bodyContains` catches it only when the agent already knows the right number; `compare` catches it
 * from the two readings alone.
 */
import { describe, it, expect } from 'vitest';
import {
  EventType,
  PredicateSchema,
  REDACTED_VALUE,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type Predicate, type PredicateSession } from './predicate.js';

function refundCall(responseBody: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'POST',
      url: 'https://pay.test/api/refund',
      status: 200,
      ok: true,
      requestBody: '{"amount":"1187.01"}',
      responseBody,
      ...extra,
    },
  } as unknown as ReticleEvent;
}

function signal(name: string, data: unknown, t = 10): ReticleEvent {
  return { type: EventType.SIGNAL, t, data: { name, data } } as unknown as ReticleEvent;
}

/** A page: element text keyed by CSS scope, a store, and an event window. */
class PageSession implements PredicateSession {
  constructor(
    private readonly events: readonly ReticleEvent[],
    private readonly texts: Record<string, string> = {},
    private readonly stores: Record<string, unknown> = {},
  ) {}
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult> {
    if (ReticleCommand.MATCH === name) {
      const scope = (args?.['query'] as { scope?: string } | undefined)?.scope ?? '';
      const text = this.texts[scope];
      const elements =
        text === undefined ? [] : [{ ref: 'e1', role: 'generic', name: '', text, visible: true }];
      return Promise.resolve({
        ok: true,
        result: { matched: elements.length > 0, count: elements.length, elements },
      } as CommandResult);
    }
    if (ReticleCommand.STATE_READ === name) {
      return Promise.resolve({ ok: true, result: { stores: this.stores } } as CommandResult);
    }
    return Promise.reject(new Error(`unexpected command ${name}`));
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

const SHOWN = { from: 'text', scope: '#refunded' } as const;
const ANSWERED = { from: 'net', urlContains: '/api/refund', path: 'refunded' } as const;

function compare(extra: Record<string, unknown>): Predicate {
  return PredicateSchema.parse({ kind: 'compare', left: SHOWN, right: ANSWERED, ...extra });
}

describe('compare catches the page disagreeing with the server', () => {
  it('fails the refund that showed the typed amount instead of the answer', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')], {
      '#refunded': 'Refunded ₹1,187.01',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.failureReason).toContain('1187.01');
    expect(r.failureReason).toContain('11.87');
    expect(r.assertion).toBe('compare.number');
  });

  it('passes when the page shows what the server answered', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')], {
      '#refunded': 'Refunded ₹11.87',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(true);
  });

  it('compares the request against the response of the same call', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')]);
    const r = await evaluatePredicate(
      session,
      PredicateSchema.parse({
        kind: 'compare',
        left: { from: 'net', urlContains: '/api/refund', body: 'request', path: 'amount' },
        right: ANSWERED,
        as: 'number',
      }),
    );
    expect(r.pass).toBe(false);
  });

  it('reads the LAST matching call, the answer the page would be showing', async () => {
    const session = new PageSession(
      [refundCall('{"refunded":5}'), refundCall('{"refunded":11.87}')],
      { '#refunded': '11.87' },
    );
    expect((await evaluatePredicate(session, compare({ as: 'number' }))).pass).toBe(true);
  });

  it('reads a store path and a signal payload path', async () => {
    const session = new PageSession(
      [signal('cart:updated', { cart: { total: 40 } })],
      {},
      {
        app: { cart: { total: 40 } },
      },
    );
    const r = await evaluatePredicate(
      session,
      PredicateSchema.parse({
        kind: 'compare',
        left: { from: 'state', path: 'cart.total' },
        right: { from: 'signal', name: 'cart:updated', path: 'cart.total' },
      }),
    );
    expect(r.pass).toBe(true);
  });
});

describe('what `as` means', () => {
  it('is strict by default: text "11.87" and the number 11.87 differ, and the miss says how to compare numbers', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')], { '#refunded': '11.87' });
    const r = await evaluatePredicate(session, compare({}));
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('as: "number"');
  });

  it('refuses to pick between two numbers in one text', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')], {
      '#refunded': '2 refunds, 11.87 total',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('2 numbers');
  });

  it('does not read a European decimal comma as a thousands separator', async () => {
    const session = new PageSession([refundCall('{"refunded":1187}')], { '#refunded': '11,87' });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
  });

  it('preserves the negative sign on formatted currency in compare as number', async () => {
    const session = new PageSession([refundCall('{"refunded":-11.87}')], {
      '#refunded': 'Refunded -₹11.87',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(true);
  });

  it('fails when negative currency on page disagrees in sign with server response', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')], {
      '#refunded': 'Refunded -₹11.87',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('-11.87');
    expect(r.failureReason).toContain('11.87');
  });

  it('handles negative currency with various symbol placements and spacing', async () => {
    const sessionUSD = new PageSession([refundCall('{"refunded":-50}')], {
      '#refunded': 'Total: -$50.00',
    });
    expect((await evaluatePredicate(sessionUSD, compare({ as: 'number' }))).pass).toBe(true);

    const sessionEUR = new PageSession([refundCall('{"refunded":-123.45}')], {
      '#refunded': 'Balance: -€123.45',
    });
    expect((await evaluatePredicate(sessionEUR, compare({ as: 'number' }))).pass).toBe(true);

    const sessionSpace = new PageSession([refundCall('{"refunded":-1187.01}')], {
      '#refunded': '-$ 1,187.01',
    });
    expect((await evaluatePredicate(sessionSpace, compare({ as: 'number' }))).pass).toBe(true);
  });

  it('applies a tolerance', async () => {
    const session = new PageSession([refundCall('{"refunded":11.874}')], { '#refunded': '11.87' });
    expect((await evaluatePredicate(session, compare({ as: 'number' }))).pass).toBe(false);
    expect(
      (await evaluatePredicate(session, compare({ as: 'number', tolerance: 0.005 }))).pass,
    ).toBe(true);
  });

  it('refuses an object or array reading instead of comparing a truncated copy', async () => {
    const session = new PageSession([refundCall('{"refunded":{"amount":11.87}}')], {
      '#refunded': '11.87',
    });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('single value');
  });
});

describe('a side nobody could read is never a pass', () => {
  it('fails when the call never happened', async () => {
    const session = new PageSession([], { '#refunded': '11.87' });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.failureReason).toContain('/api/refund');
  });

  it('fails when the element is not on the page', async () => {
    const session = new PageSession([refundCall('{"refunded":11.87}')]);
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
  });

  it('is unknown when the body was never recorded', async () => {
    const call = refundCall('{"refunded":11.87}');
    delete (call.data as Record<string, unknown>)['responseBody'];
    const session = new PageSession([call], { '#refunded': '11.87' });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('not recorded');
  });

  it('is unknown when the body was truncated before the field', async () => {
    const call = refundCall('{"amount":1', { responseBodyTruncated: true });
    const session = new PageSession([call], { '#refunded': '11.87' });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('TRUNCATED');
  });

  it('is unknown when the field was redacted', async () => {
    const call = refundCall(`{"refunded":"${REDACTED_VALUE}"}`);
    const session = new PageSession([call], { '#refunded': '11.87' });
    const r = await evaluatePredicate(session, compare({ as: 'number' }));
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('redacted');
  });

  it('is unknown when a signal field was redacted', async () => {
    const session = new PageSession([signal('refund', { refunded: REDACTED_VALUE })], {
      '#refunded': '11.87',
    });
    const r = await evaluatePredicate(
      session,
      PredicateSchema.parse({
        kind: 'compare',
        left: SHOWN,
        right: { from: 'signal', name: 'refund', path: 'refunded' },
        as: 'number',
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('redacted');
  });
});

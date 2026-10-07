/**
 * A truncated response body and a `bodyMatches` clause: undecidable, with a remedy that can work
 * (#1417).
 *
 * Inconclusive was always the honest grade. The remedy was not: it said to "assert on something
 * inside the recorded prefix", and an agent that did that with `bodyMatches` got the identical
 * result, because a JSON prefix never parses. The failure was also labelled `net.bodyContains`
 * whichever clause was asked.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

/** A ~20 KB JSON body whose first key is the one asked about, cut at the default 8192 cap. */
const FULL = JSON.stringify({ status: 'ok', rows: 'x'.repeat(20_000) });
const PREFIX = FULL.slice(0, 8192);

function bigResponse(): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'GET',
      url: 'https://app.test/api/big',
      status: 200,
      ok: true,
      responseBody: PREFIX,
      responseBodyTruncated: true,
    },
  } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  command(): Promise<never> {
    return Promise.reject(new Error('no element commands in these tests'));
  }
  eventsSince(): ReticleEvent[] {
    return [bigResponse()];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 100;
  }
}

const judge = (clause: Record<string, unknown>) =>
  evaluatePredicate(new WindowSession(), { kind: 'net', urlContains: '/big', ...clause });

describe('bodyMatches on a truncated body', () => {
  it('stays inconclusive, even though the wanted field is in the kept prefix', async () => {
    const r = await judge({ bodyMatches: { status: 'ok' } });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.failureReason).toBeUndefined();
  });

  it('names the cap and bodyContains, and does not send it back to bodyMatches on the prefix', async () => {
    const r = await judge({ bodyMatches: { status: 'ok' } });
    expect(r.inconclusive).toContain('networkBodyMaxChars');
    expect(r.inconclusive).toContain('`bodyContains`');
    expect(r.inconclusive).not.toContain('assert on something inside the recorded prefix');
  });

  it('is labelled with the clause that was asked', async () => {
    expect((await judge({ bodyMatches: { status: 'ok' } })).assertion).toBe('net.bodyMatches');
  });
});

describe('bodyContains on a truncated body is unchanged', () => {
  it('keeps the prefix advice and its own label', async () => {
    const r = await judge({ bodyContains: 'not-in-the-prefix' });
    expect(r.inconclusive).toContain('assert on something inside the recorded prefix');
    expect(r.assertion).toBe('net.bodyContains');
  });
});

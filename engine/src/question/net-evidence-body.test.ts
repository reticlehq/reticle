/**
 * The verdict quoted a 9,861-byte response body to prove a status code.
 *
 * Measured in a field session against a CAD app: six `act_and_wait` calls through one interview, each
 * asserting `{ net: { urlContains, status: 200 } }`, each returning `verdict.evidence` containing the
 * server's entire answer. The document was the same interview state growing by one slot per step, so
 * ~95% of every payload was a re-send of what the agent had already been given, and the evidence
 * block was 9,693 of an 11,194-byte result. Thirty such calls came to 181KB.
 *
 * This file's own `MAX_BODY_IN_FAILURE` already stated the rule for the failing path — "enough of a
 * body to see what differed, without paying for a whole payload in every verdict". It was never
 * applied to the passing one.
 *
 * The line is NOT "bodies are expensive". It is that evidence should answer the claim that was made.
 * A predicate that asked about status and url is proved by status and url; a predicate that asked
 * `bodyContains` is proved by the body, and that one keeps it in full. Clipping the body a check
 * actually read would be weakening a check to make it cheaper, which is the one trade this codebase
 * does not make.
 */
import { describe, expect, it } from 'vitest';
import { EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate/predicate-eval.js';

const BIG = `{"payload":"${'x'.repeat(9000)}","needle":"interview-complete"}`;

let seq = 0;
const netEvent = (): ReticleEvent => {
  seq += 1;
  return {
    t: seq,
    seq,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: '/api/interview/answer',
      status: 200,
      ok: true,
      responseSize: BIG.length,
      responseBody: BIG,
      requestBody: '{"slot":"dim","value":"3D"}',
    },
  };
};

const evidenceOf = (predicate: Parameters<typeof evalNet>[1]): Record<string, unknown> => {
  const result = evalNet([netEvent()], predicate);
  expect(result.pass).toBe(true);
  return (result.evidence ?? {}) as Record<string, unknown>;
};

const statusOnly = {
  kind: PredicateKind.NET,
  urlContains: '/api/interview/answer',
  status: 200,
} as const;

describe('evidence for a claim that never read the body', () => {
  it('does not carry the whole response body', () => {
    const body = evidenceOf(statusOnly)['responseBody'];
    expect(String(body).length).toBeLessThan(BIG.length);
  });

  it('still proves the claim that WAS made', () => {
    const evidence = evidenceOf(statusOnly);
    expect(evidence['status']).toBe(200);
    expect(evidence['url']).toBe('/api/interview/answer');
    expect(evidence['ok']).toBe(true);
  });

  it('says the body was clipped rather than looking like a short answer', () => {
    // An absent or silently-truncated body reads as "the server answered this much", which is a
    // different and wrong fact. The size is already carried; the elision has to be visible too.
    const evidence = evidenceOf(statusOnly);
    expect(String(evidence['responseBody'])).toContain('…');
    expect(evidence['responseSize']).toBe(BIG.length);
  });

  it('clips the request body on the same rule', () => {
    const long = { ...netEvent() };
    long.data['requestBody'] = BIG;
    const result = evalNet([long], statusOnly);
    const evidence = (result.evidence ?? {}) as Record<string, unknown>;
    expect(String(evidence['requestBody']).length).toBeLessThan(BIG.length);
  });

  it('leaves a body that is already small completely alone', () => {
    const small = netEvent();
    small.data['responseBody'] = '{"ok":true}';
    const result = evalNet([small], statusOnly);
    const evidence = (result.evidence ?? {}) as Record<string, unknown>;
    expect(evidence['responseBody']).toBe('{"ok":true}');
  });
});

/**
 * What actually proves a `bodyContains` match.
 *
 * The field session's six interview steps each asked for one needle and each got the whole 8KB
 * document back — the same document, growing by one slot per step. The document does not prove the
 * match any better than the matched region does, and it costs forty times as much. So the evidence
 * for a body clause is the MATCH: the needle in its context, and where it was found. That is
 * strictly more precise than the payload it replaces, not less.
 */
describe('evidence for a claim that DID read the body', () => {
  const matched = (): Record<string, unknown> =>
    evidenceOf({ ...statusOnly, bodyContains: 'interview-complete' });

  it('quotes the needle, which is the thing that was proved', () => {
    expect(String(matched()['responseBody'])).toContain('interview-complete');
  });

  it('does not return the whole document to prove one substring', () => {
    expect(String(matched()['responseBody']).length).toBeLessThan(BIG.length);
  });

  it('says WHERE the match was, so the quote can be located in the real body', () => {
    expect(matched()['bodyMatchAt']).toBe(BIG.indexOf('interview-complete'));
  });

  it('keeps the true size, so a clipped quote is never read as a short answer', () => {
    expect(matched()['responseSize']).toBe(BIG.length);
  });

  it('leaves a short body whole rather than windowing something already cheap', () => {
    const small = netEvent();
    small.data['responseBody'] = '{"state":"interview-complete"}';
    const result = evalNet([small], { ...statusOnly, bodyContains: 'interview-complete' });
    const evidence = (result.evidence ?? {}) as Record<string, unknown>;
    expect(evidence['responseBody']).toBe('{"state":"interview-complete"}');
    expect(evidence['bodyMatchAt']).toBeUndefined();
  });
});

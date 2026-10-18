/**
 * A check an agent recorded without an `intent` reached the platform as its predicate alone, so its
 * issue was titled with engine wording ("a request PATCH matching '/assignee'") or "Check failed: …".
 * Every check now carries a person's sentence: the agent's, else one built here from the predicate,
 * in the voice of the failure a reader opens it for. A conjunction names the one part that failed.
 */
import { describe, expect, it } from 'vitest';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';
import {
  checkIntent,
  expectSentence,
  failedPartOf,
  failureSentence,
  journeySentence,
} from './check-sentence.js';

const net = (method: string, urlContains: string): Predicate => ({
  kind: PredicateKind.NET,
  method,
  urlContains,
});
const text = (contains: string): Predicate => ({ kind: PredicateKind.TEXT, contains });

describe('a check in words, when the agent gave none', () => {
  it('says what did not happen, for each kind of claim', () => {
    expect(failureSentence(net('PATCH', '/assignee'))).toBe(
      'No PATCH request to /assignee was made',
    );
    expect(failureSentence({ kind: PredicateKind.NET })).toBe('No request was made');
    expect(failureSentence(text('Copied'))).toBe('The text "Copied" never appeared');
    expect(failureSentence({ kind: PredicateKind.ROUTE, pathname: '/welcome' })).toBe(
      'The page never moved to /welcome',
    );
    expect(failureSentence({ kind: PredicateKind.ROUTE, contains: 'issue=' })).toBe(
      'The address never came to hold "issue="',
    );
    expect(failureSentence({ kind: PredicateKind.SIGNAL, name: 'auth:code_sent' })).toBe(
      'The app never reported "auth:code_sent"',
    );
    expect(failureSentence({ kind: PredicateKind.ELEMENT, query: { role: 'dialog' } })).toBe(
      'No dialog appeared',
    );
    expect(
      failureSentence({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: 'Pay' },
        state: 'enabled',
      }),
    ).toBe('The button "Pay" was not enabled');
    expect(failureSentence({ kind: PredicateKind.ELEMENT, query: { testid: 'x' } })).toBe(
      'The element marked "x" never appeared',
    );
  });

  it('says what happened that should not have, for an absence', () => {
    expect(
      failureSentence({ kind: PredicateKind.NOT, predicate: net('DELETE', '/v1/members') }),
    ).toBe('A DELETE request to /v1/members happened, and it should not have');
    expect(failureSentence({ kind: PredicateKind.TEXT, contains: 'Error', absent: true })).toBe(
      'The text "Error" appeared, and it should not have',
    );
  });

  it('names the one part of a conjunction that failed', () => {
    const both: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [text('Saved'), net('PATCH', '/assignee')],
    };
    expect(failureSentence(both, 1)).toBe('No PATCH request to /assignee was made');
    expect(failureSentence(both)).toBe(
      'Not all of these happened: the text "Saved"; a PATCH request to /assignee',
    );
    expect(
      failureSentence({ kind: PredicateKind.ANY_OF, predicates: [text('A'), text('B')] }),
    ).toBe('None of these happened: the text "A"; the text "B"');
  });
});

/*
 * A strict check (promoCode in the order body) on a checkout that DID post the order was titled "No
 * POST request to /api/orders was made", sending the reader to the wiring, which was fine. The
 * verdict's assertion says the matching call was made and only a body clause missed.
 */
describe('a request that was made, without what the check asked it to carry', () => {
  const strict: Predicate = {
    kind: PredicateKind.NET,
    method: 'POST',
    urlContains: '/api/orders',
    requestBodyMatches: { promoCode: 'SAVE20' },
  };

  it('says the request was made and names what it did not carry', () => {
    expect(failureSentence(strict, undefined, 'net.requestBody')).toBe(
      'A POST request to /api/orders was made, but it did not carry {"promoCode":"SAVE20"}',
    );
    expect(
      failureSentence(
        { kind: PredicateKind.NET, urlContains: '/api/total', bodyContains: '1187.01' },
        undefined,
        'net.bodyContains',
      ),
    ).toBe('A request to /api/total was made, but its answer did not carry "1187.01"');
  });

  it('still says no request was made when none was', () => {
    expect(failureSentence(strict)).toBe('No POST request to /api/orders was made');
  });

  it('reads the assertion of the part of a conjunction that failed', () => {
    const both: Predicate = { kind: PredicateKind.ALL_OF, predicates: [text('Saved'), strict] };
    expect(
      checkIntent(both, {
        evidence: [{ pass: true }, { pass: false, assertion: 'net.requestBody' }],
      }).intent,
    ).toBe('A POST request to /api/orders was made, but it did not carry {"promoCode":"SAVE20"}');
    expect(checkIntent(strict, { assertion: 'net.requestBody' }).intent).toBe(
      'A POST request to /api/orders was made, but it did not carry {"promoCode":"SAVE20"}',
    );
  });
});

describe('which part of a conjunction failed', () => {
  const both: Predicate = {
    kind: PredicateKind.ALL_OF,
    predicates: [text('Saved'), net('PATCH', '/assignee')],
  };

  it('reads it from the per-part results the evaluation kept', () => {
    expect(failedPartOf(both, [{ pass: true }, { pass: false }])).toBe(1);
    expect(failedPartOf(both, [{ pass: false, inconclusive: 'x' }, { pass: false }])).toBe(1);
  });

  it('says nothing for a pass, a leaf, or evidence it cannot read', () => {
    expect(failedPartOf(both, [{ pass: true }, { pass: true }])).toBeUndefined();
    expect(failedPartOf(text('Saved'), [{ pass: false }])).toBeUndefined();
    expect(failedPartOf(both, 'nothing')).toBeUndefined();
  });
});

describe('the intent a recorded check carries', () => {
  const both: Predicate = {
    kind: PredicateKind.ALL_OF,
    predicates: [text('Saved'), net('PATCH', '/assignee')],
  };

  it("keeps the agent's own words", () => {
    expect(checkIntent(both, {}, 'changing the assignee saves')).toEqual({
      intent: 'changing the assignee saves',
    });
  });

  it('builds the sentence otherwise, and says so, with the part that failed', () => {
    expect(checkIntent(both, { evidence: [{ pass: true }, { pass: false }] })).toEqual({
      intent: 'No PATCH request to /assignee was made',
      intentDerived: true,
      failedPart: 1,
    });
  });
});

/*
 * An auto-saved drive with no declared intent was named by its request path and a hash
 * ("drive-get-v1-runs-issues-c69f82"), and its file said nothing about what it was for.
 */
describe('a journey in one sentence, from what its steps expect', () => {
  it('says what each claim makes true', () => {
    expect(expectSentence(net('POST', '/api/login'))).toBe('A POST request to /api/login is made');
    expect(expectSentence(text('Saved'))).toBe('The text "Saved" appears');
    expect(expectSentence({ kind: PredicateKind.ROUTE, pathname: '/home' })).toBe(
      'The page moves to /home',
    );
    expect(expectSentence({ kind: PredicateKind.NOT, predicate: net('DELETE', '/x') })).toBe(
      'A DELETE request to /x does not happen',
    );
  });

  it('joins the first two claims in order and skips a bare wait for idle', () => {
    expect(
      journeySentence([
        { kind: PredicateKind.SETTLED },
        net('POST', '/api/login'),
        { kind: PredicateKind.ROUTE, pathname: '/home' },
        text('Welcome'),
      ]),
    ).toBe('A POST request to /api/login is made, then the page moves to /home');
    expect(journeySentence([{ kind: PredicateKind.SETTLED }])).toBeUndefined();
  });
});

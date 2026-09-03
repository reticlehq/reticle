/**
 * What the caller DECLARED, read back off the oracle.
 *
 * The agent names the expected consequence before acting, and until now nothing downstream read that
 * declaration — so a verdict could be decided by a channel the caller never asked about, and the
 * reason never named the channel that decided it.
 */

import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { declaredExpectations, declaresBodyIndependentChannel } from './declared.js';

describe('a declared failing request is a declaration, not a contradiction', () => {
  it('reads a bare failing net predicate', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.NET,
      method: 'POST',
      urlContains: '/api/v1/auth/login',
      status: 500,
    });
    expect(declared.netFailures).toEqual([
      { method: 'POST', urlContains: '/api/v1/auth/login', status: 500 },
    ]);
  });

  it('reads one out of an allOf, which is how an error path is actually declared', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.NET, urlContains: '/api/login', status: 401 },
        { kind: PredicateKind.TEXT, contains: 'Incorrect email or password' },
        { kind: PredicateKind.CONSOLE, absent: true },
      ],
    });
    expect(declared.netFailures).toHaveLength(1);
    expect(declared.rendersContent).toBe(true);
  });

  it('reads `ok: false`, which is the honest field for IPC (no status code)', () => {
    expect(
      declaredExpectations({ kind: PredicateKind.NET, urlContains: 'ipc://sync', ok: false })
        .netFailures,
    ).toEqual([{ urlContains: 'ipc://sync' }]);
  });

  // Negative control: a SUCCESS is not a declared failure, and reading it as one would suppress the
  // contradiction on every asserted request in the product.
  it('does not read a success as a declared failure', () => {
    expect(
      declaredExpectations({ kind: PredicateKind.NET, urlContains: '/api/save', status: 200 })
        .netFailures,
    ).toEqual([]);
  });

  // Negative control: under anyOf nothing is guaranteed to have held, so a declaration there is not
  // a declaration about this window. Honouring it would suppress a real contradiction on the
  // strength of a branch that never ran.
  it('ignores an anyOf branch — nothing in it is guaranteed to have held', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.ANY_OF,
      predicates: [
        { kind: PredicateKind.NET, urlContains: '/api/login', status: 500 },
        { kind: PredicateKind.TEXT, contains: 'Welcome' },
      ],
    });
    expect(declared.netFailures).toEqual([]);
    expect(declared.rendersContent).toBe(false);
  });

  it('ignores a negated branch — `not` declares the opposite of a consequence', () => {
    expect(
      declaredExpectations({
        kind: PredicateKind.NOT,
        predicate: { kind: PredicateKind.NET, urlContains: '/api/login', status: 500 },
      }).netFailures,
    ).toEqual([]);
  });
});

describe('a declared visible consequence', () => {
  it('counts an element predicate as content the caller required on screen', () => {
    expect(
      declaredExpectations({ kind: PredicateKind.ELEMENT, query: { text: 'Reset your password' } })
        .rendersContent,
    ).toBe(true);
  });

  // Negative control: an ABSENCE proves nothing was rendered — reading it as a rendered consequence
  // would silence the blank-destination check on exactly the assertion that cannot witness content.
  it('does not count an absence as rendered content', () => {
    expect(
      declaredExpectations({
        kind: PredicateKind.ELEMENT,
        query: { text: 'Spinner' },
        absent: true,
      }).rendersContent,
    ).toBe(false);
    expect(
      declaredExpectations({ kind: PredicateKind.TEXT, contains: 'Error', absent: true })
        .rendersContent,
    ).toBe(false);
  });

  it('does not count a route or signal predicate — neither witnesses anything on screen', () => {
    expect(
      declaredExpectations({
        kind: PredicateKind.ALL_OF,
        predicates: [
          { kind: PredicateKind.ROUTE, pathname: '/forgot-password' },
          { kind: PredicateKind.SIGNAL, name: 'auth:reset' },
        ],
      }).rendersContent,
    ).toBe(false);
  });
});

/**
 * An unread 2xx body is only a veto when the body is the only remaining channel. The caller naming
 * a string on screen, a store path, a signal, a route, or an element located by role / name /
 * testid — and that holding — is a channel the body does not own, so the unread clause must be
 * able to see it. Conservative about what counts, same as the rest of this file: only the top
 * level and `allOf`. An `anyOf` branch may never have held.
 */
describe('a declared channel independent of the response body', () => {
  it('reads an exact string', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.TEXT,
        contains: 'unique-message-row',
      }),
    ).toBe(true);
  });

  it('reads a signal', () => {
    expect(
      declaresBodyIndependentChannel({ kind: PredicateKind.SIGNAL, name: 'message:created' }),
    ).toBe(true);
  });

  it('reads a store path', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.STATE,
        path: 'messages.length',
        equals: 4,
      }),
    ).toBe(true);
  });

  it('reads the unique row out of an allOf that also names the 201', () => {
    // The reported case: POST /api/chat/messages → 201 AND the exact message text on screen.
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ALL_OF,
        predicates: [
          { kind: PredicateKind.NET, urlContains: '/api/chat/messages', status: 201 },
          { kind: PredicateKind.TEXT, contains: 'unique-message-row' },
        ],
      }),
    ).toBe(true);
  });

  it('does not read a net-only declaration — the body is then the only remaining channel', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.NET,
        urlContains: '/api/bulk-hold',
        status: 200,
      }),
    ).toBe(false);
  });

  it('ignores an anyOf branch — nothing in it is guaranteed to have held', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ANY_OF,
        predicates: [
          { kind: PredicateKind.NET, urlContains: '/api/save', status: 200 },
          { kind: PredicateKind.TEXT, contains: 'Saved' },
        ],
      }),
    ).toBe(false);
  });

  it('reads a route the caller named before the action', () => {
    expect(declaresBodyIndependentChannel({ kind: PredicateKind.ROUTE, pathname: '/lobby' })).toBe(
      true,
    );
  });

  it('reads an element located by role and name', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ELEMENT,
        query: { role: 'heading', name: 'Lobby' },
      }),
    ).toBe(true);
  });

  it('reads an element located by testid', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ELEMENT,
        query: { testid: 'lobby-heading' },
      }),
    ).toBe(true);
  });

  it('reads a route out of an allOf that also names the write', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ALL_OF,
        predicates: [
          { kind: PredicateKind.NET, urlContains: '/api/join', status: 200 },
          { kind: PredicateKind.ROUTE, pathname: '/lobby' },
        ],
      }),
    ).toBe(true);
  });

  it('does not read an absent element — absence is not a consequence the body cannot own', () => {
    expect(
      declaresBodyIndependentChannel({
        kind: PredicateKind.ELEMENT,
        query: { role: 'heading', name: 'Lobby' },
        absent: true,
      }),
    ).toBe(false);
  });
});

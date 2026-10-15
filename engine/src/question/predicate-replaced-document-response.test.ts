/**
 * #1529: a write that makes the app navigate can be proven afterwards.
 *
 * A Delete button sends `DELETE /api/items/1` and, on 204, sets `location.href = "/"`. Predicate
 * evidence is scoped to the document on screen (see predicate-document-scope.test.ts), so the DELETE,
 * recorded under the page that has since been replaced, was dropped. Once the new page made a request
 * of its own the window was not empty, and `net DELETE 204` answered a plain `no`: a failed mutation,
 * while the server had answered 204.
 *
 * A response is a server fact, not page state, so a `net` predicate now keeps an answered request
 * from a replaced document when it falls inside an explicit `since` window: the caller's cursor from
 * before the action. Without a floor the request could be from any earlier page, so it is not counted;
 * if it would have satisfied the predicate, the answer is `unknown`, never a plain `no`. A request the
 * server never answered, and every other window-only kind, stay scoped to the document on screen.
 */

import { describe, expect, it } from 'vitest';
import { EventType, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate/predicate.js';
import type { Predicate } from './predicate/predicate.js';

let seq = 10;
function ev(type: EventType, data: Record<string, unknown>, documentId: string): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data, documentId };
}

const answered = (method: string, url: string, status: number, documentId: string): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status }, documentId);

/** A NET_REQUEST with no status and no `ok`: a subresource whose answer nobody could read. */
const unread = (url: string, documentId: string): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method: 'DELETE', url }, documentId);

function windowSession(events: ReticleEvent[], currentDocumentId: string): PredicateSession {
  return {
    command: (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
    eventsSince: (since: number): ReticleEvent[] => events.filter((e) => e.t >= since),
    onEvent: (): (() => void) => (): void => {},
    elapsed: (): number => 1000,
    currentDocumentId,
  };
}

const DELETE_204: Predicate = {
  kind: 'net',
  method: 'DELETE',
  urlContains: '/api/items/1',
  status: 204,
};

/** The issue's window: the DELETE under doc A, then the home page's own GET under doc B. */
function deleteThenNavigate(): { session: PredicateSession; since: number } {
  const since = seq + 1;
  const session = windowSession(
    [answered('DELETE', '/api/items/1', 204, 'doc-a'), answered('GET', '/api/home', 200, 'doc-b')],
    'doc-b',
  );
  return { session, since };
}

describe('a net predicate over a write that navigated away', () => {
  it('passes inside the caller’s since window, though the request ran on the replaced page', async () => {
    const { session, since } = deleteThenNavigate();
    const result = await evaluatePredicate(session, DELETE_204, since);
    expect(result.pass).toBe(true);
  });

  it('passes when the floor is the predicate’s own since', async () => {
    const { session, since } = deleteThenNavigate();
    const result = await evaluatePredicate(session, { ...DELETE_204, since });
    expect(result.pass).toBe(true);
  });

  it('is unknown, never a plain no, without a since floor', async () => {
    const { session } = deleteThenNavigate();
    const result = await evaluatePredicate(session, DELETE_204);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('before the navigation');
    expect(result.inconclusive).toContain('since');
  });

  it('still says no when the replaced page’s answer does not match either', async () => {
    const since = seq + 1;
    const session = windowSession(
      [
        answered('DELETE', '/api/items/1', 500, 'doc-a'),
        answered('GET', '/api/home', 200, 'doc-b'),
      ],
      'doc-b',
    );
    const result = await evaluatePredicate(session, DELETE_204, since);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('does not count a replaced page’s request the server never answered', async () => {
    const since = seq + 1;
    const session = windowSession(
      [unread('/api/items/1', 'doc-a'), answered('GET', '/api/home', 200, 'doc-b')],
      'doc-b',
    );
    const loose: Predicate = { kind: 'net', method: 'DELETE', urlContains: '/api/items/1' };
    expect((await evaluatePredicate(session, loose, since)).pass).toBe(false);
  });

  it('leaves a request from before the since floor out, as before', async () => {
    const early = answered('DELETE', '/api/items/1', 204, 'doc-a');
    const since = seq + 1;
    const session = windowSession([early, answered('GET', '/api/home', 200, 'doc-b')], 'doc-b');
    expect((await evaluatePredicate(session, DELETE_204, since)).pass).toBe(false);
  });

  it('keeps every other window-only kind scoped to the document on screen', async () => {
    const since = seq + 1;
    const session = windowSession(
      [
        ev(EventType.CONSOLE_ERROR, { message: 'boom' }, 'doc-a'),
        answered('GET', '/api/home', 200, 'doc-b'),
      ],
      'doc-b',
    );
    const noErrors: Predicate = { kind: 'console', level: 'error', absent: true };
    expect((await evaluatePredicate(session, noErrors, since)).pass).toBe(true);
  });

  it('does not keep a replaced page’s answer to a read: a GET is page state', async () => {
    // The old page polls after the action starts and gets 200; the page now on screen gets 500.
    // Counting the old 200 would pass "did the reloaded page load its items" on a page that did not.
    const since = seq + 1;
    const session = windowSession(
      [answered('GET', '/api/items', 200, 'doc-a'), answered('GET', '/api/items', 500, 'doc-b')],
      'doc-b',
    );
    const loaded: Predicate = {
      kind: 'net',
      method: 'GET',
      urlContains: '/api/items',
      status: 200,
    };
    expect((await evaluatePredicate(session, loaded, since)).pass).toBe(false);
  });

  it('does not turn a read miss into unknown without a floor either', async () => {
    const session = windowSession(
      [answered('GET', '/api/items', 200, 'doc-a'), answered('GET', '/api/items', 500, 'doc-b')],
      'doc-b',
    );
    const loaded: Predicate = {
      kind: 'net',
      method: 'GET',
      urlContains: '/api/items',
      status: 200,
    };
    const result = await evaluatePredicate(session, loaded);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });
});

/**
 * A predicate must not be answered by an event belonging to a page that no longer exists.
 *
 * The contradiction pass was scoped to the document under observation; the predicate engine was not,
 * and it is the sharper of the two — `reticle_assert` and `act_and_wait { until }` both resolve here,
 * and both produce the verdict an agent gates on. A window is scoped by time and by ring-buffer
 * capacity and by nothing else, so it can still hold the traffic, the console output and the signals
 * of a document a full navigation or a reload has already thrown away.
 *
 * Both directions are defects. A stale event that SATISFIES a predicate is a false green — the worst
 * outcome a verification tool has. A stale event that REFUTES one is a false red, which sends an
 * agent to fix code that was never at fault.
 *
 * The no-change case matters most, so it is asserted first: a window whose evidence all belongs to
 * the document on screen — or to an SDK too old to stamp one — must evaluate exactly as it always did.
 */

import { describe, expect, it } from 'vitest';
import { EventType, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import type { Predicate } from './predicate.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, documentId?: string): ReticleEvent {
  seq += 1;
  const base: ReticleEvent = { t: seq, seq, type, sessionId: 's', data };
  return documentId === undefined ? base : { ...base, documentId };
}

const call = (documentId?: string): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method: 'GET', url: '/api/x' }, documentId);
const consoleError = (documentId?: string): ReticleEvent =>
  ev(EventType.CONSOLE_ERROR, { message: 'boom' }, documentId);
const domChanged = (documentId?: string): ReticleEvent =>
  ev(EventType.DOM_ADDED, { path: 'li' }, documentId);

/** The window and the document on screen — the only two things this behaviour reads. */
function windowSession(
  events: ReticleEvent[],
  currentDocumentId?: string,
  url?: string,
): PredicateSession {
  return {
    command: (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
    eventsSince: (): ReticleEvent[] => events,
    onEvent: (): (() => void) => (): void => {},
    elapsed: (): number => 1000,
    ...(currentDocumentId === undefined ? {} : { currentDocumentId }),
    ...(url === undefined ? {} : { url }),
  };
}

const NET_X: Predicate = { kind: 'net', urlContains: '/api/x' };

describe('predicate evidence is scoped to the document currently under observation', () => {
  it('is satisfied by a same-document event exactly as before', async () => {
    const session = windowSession([call('doc-a')], 'doc-a');
    expect((await evaluatePredicate(session, NET_X)).pass).toBe(true);
  });

  it('is satisfied by an UNSTAMPED event, because an older SDK stamps nothing', async () => {
    const session = windowSession([call()], 'doc-a');
    expect((await evaluatePredicate(session, NET_X)).pass).toBe(true);
  });

  it('is NOT satisfied by an event from a document since replaced', async () => {
    // The false green: the call happened, under a page that has since gone away.
    const session = windowSession([call('doc-a'), domChanged('doc-b')], 'doc-b');
    expect((await evaluatePredicate(session, NET_X)).pass).toBe(false);
  });

  it('is NOT refuted by an event from a document since replaced', async () => {
    // The false red, and the mirror of the case above: an absence assertion that a dead page's
    // console error would have failed, while the page on screen produced nothing of the kind.
    const absent: Predicate = { kind: 'console', level: 'error', absent: true };
    const session = windowSession([consoleError('doc-a'), domChanged('doc-b')], 'doc-b');
    expect((await evaluatePredicate(session, absent)).pass).toBe(true);
  });

  it('reports a window emptied by supersession as inconclusive, not as false', async () => {
    const session = windowSession([call('doc-a')], 'doc-b');
    const result = await evaluatePredicate(session, NET_X);
    expect(result.pass).toBe(false);
    // The whole user-visible point: an agent told this knows to re-drive; one told the call never
    // happened does not.
    expect(result.inconclusive).toContain('replaced');
  });

  it('leaves a genuinely empty window a plain failure, not an inconclusive one', async () => {
    const session = windowSession([], 'doc-b');
    const result = await evaluatePredicate(session, NET_X);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('does not let a window emptied by supersession read as a settled page', async () => {
    // `settled` answers "no activity to settle" on an empty window — true of a quiet page and false
    // of one whose activity was discarded with the document that produced it.
    const settled: Predicate = { kind: 'settled' };
    const session = windowSession([call('doc-a')], 'doc-b');
    const result = await evaluatePredicate(session, settled);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('replaced');
  });

  it('still answers a route predicate from the live URL when the window is emptied', async () => {
    // Route has a second source of truth — where the app is RIGHT NOW — which is current by
    // definition, so supersession must not take that answer away.
    const route: Predicate = { kind: 'route', pathname: '/login' };
    const session = windowSession([call('doc-a')], 'doc-b', 'http://localhost/login');
    expect((await evaluatePredicate(session, route)).pass).toBe(true);
  });
});

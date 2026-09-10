import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  type HelloMessage,
} from '@reticlehq/core';
import { Session } from './session.js';

const hello = (): HelloMessage => ({
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 's1',
  url: 'http://localhost/app',
  title: 'App',
  adapters: [],
});
const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;

/**
 * An action's OWN effects must never be learned as ambient background churn.
 *
 * `Session.pushEvent` classifies an unattributed, ref-bearing event as ambient. The settle oracle then
 * drops events on learned-ambient regions before deciding whether the page has settled. Together those
 * are correct — a chat ticker must not hold settle open forever.
 *
 * The danger is a dispatch path that forgets to open the attribution window. Its effects arrive with no
 * actionId, get counted as background, and past the ambient threshold the settle oracle stops looking at
 * the very region the app reacts in — so `{kind:"settled"}` returns settled while work is still in
 * flight. That is a false green produced by the anti-false-green machinery, and it is invisible: every
 * call succeeds, the counts just drift.
 *
 * These tests pin the CLASSIFIER: an attributed event is not counted as ambient, an unattributed one
 * is. They do NOT and cannot catch a dispatch path that forgets to open a window — they call pushEvent
 * directly and never look at call sites. An earlier version of this comment claimed otherwise, and that
 * false claim is exactly why two more forgetful paths (flow-replay, replay) went unnoticed after the
 * first three were fixed. `dispatch-attribution.test.ts` scans call sites and is the guard for that.
 */

function sessionWithRefEvent(): { session: Session; push: (actionId?: string) => void } {
  const session = new Session(hello(), noopSocket, () => 0);
  const push = (actionId?: string): void => {
    session.pushEvent({
      t: 0,
      type: EventType.DOM_ADDED,
      sessionId: 's1',
      ref: 'e1',
      ...(actionId === undefined ? {} : { actionId }),
      data: { region: 'results-list' },
    });
  };
  return { session, push };
}

describe('action attribution vs ambient learning', () => {
  it('counts an UNATTRIBUTED ref-bearing event as ambient (the behaviour being protected)', () => {
    const { session, push } = sessionWithRefEvent();
    push();
    push();
    expect(Object.values(session.ambientCounts()).some((n) => n > 0)).toBe(true);
  });

  it('does NOT count an event that happened inside an action window', () => {
    const { session } = sessionWithRefEvent();
    session.beginAction('reticle_act', { ref: 'e1' });
    session.pushEvent({
      t: 0,
      type: EventType.DOM_ADDED,
      sessionId: 's1',
      ref: 'e1',
      data: { region: 'results-list' },
    });
    session.finishAction();
    // The action's own effect must not teach the settle oracle that this region is background noise.
    expect(Object.values(session.ambientCounts()).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a burst of action-caused effects never accumulates ambient weight', () => {
    // The failure mode was gradual: ~20 unattributed effects on a region were enough to have it
    // filtered out of the settle check permanently. Twenty attributed ones must count for nothing.
    const { session } = sessionWithRefEvent();
    for (let i = 0; i < 20; i += 1) {
      session.beginAction('reticle_act', { ref: 'e1' });
      session.pushEvent({
        t: 0,
        type: EventType.DOM_ADDED,
        sessionId: 's1',
        ref: 'e1',
        data: { region: 'results-list' },
      });
      session.finishAction();
    }
    expect(session.ambientCounts()['results-list'] ?? 0).toBe(0);
  });
});

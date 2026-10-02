/**
 * A person's clicks on the HUD are telemetry, never evidence about the app.
 *
 * Reticle's own panel changing was once counted as the app's DOM changing, and it suppressed the
 * contradiction that catches a route which rendered nothing (a false green, fixed with the HUD's
 * removals ignored). HUD use rides the same socket as the app's events, so the session takes it off
 * before the buffer: no verdict window, settle clock or agent read can see it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from './session.js';
import { getSessionMetrics, resetSessionMetrics } from '@/telemetry/session-metrics.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const hudEvent = (data: Record<string, unknown>): ReticleEvent => ({
  seq: 1,
  t: 1,
  type: EventType.HUD_USED,
  sessionId: 'demo',
  data,
});

afterEach(() => resetSessionMetrics());

describe('HUD use is taken off before the evidence buffer', () => {
  it('reaches the session summary and never the events a verdict reads', () => {
    const session = new Session(HELLO, { send: () => undefined } as unknown as WebSocket, () => 0);
    session.pushEvent(hudEvent({ control: 'annotate-btn' }));
    expect(session.eventsSince(0)).toEqual([]);
    expect(getSessionMetrics().summarize(false).hudControls).toEqual({ 'annotate-btn': 1 });
  });

  it('drops a control id the HUD never rendered', () => {
    const session = new Session(HELLO, { send: () => undefined } as unknown as WebSocket, () => 0);
    session.pushEvent(hudEvent({ control: 'text somebody typed' }));
    expect(session.eventsSince(0)).toEqual([]);
    expect(getSessionMetrics().summarize(false).hudControls).toBeUndefined();
  });
});

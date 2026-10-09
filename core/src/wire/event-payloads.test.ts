import { describe, expect, it } from 'vitest';
import { EventType } from './constants/constants.js';
import {
  EVENT_PAYLOAD_SCHEMAS,
  ROUTE_CHANGE_HOW_FIELD,
  RouteChangeHow,
  parseEventPayload,
} from './event-payloads.js';

describe('EVENT_PAYLOAD_SCHEMAS', () => {
  it('defines a payload schema for every EventType (no untyped event on the wire)', () => {
    for (const type of Object.values(EventType)) {
      expect(EVENT_PAYLOAD_SCHEMAS[type], `missing payload schema for ${type}`).toBeDefined();
    }
  });
});

describe('parseEventPayload', () => {
  it('narrows a well-formed net.request payload', () => {
    const r = parseEventPayload(EventType.NET_REQUEST, {
      id: 'r1',
      method: 'GET',
      url: '/api/x',
      status: 200,
      ok: true,
      durationMs: 12,
      initiator: 'fetch',
    });
    expect(r.success).toBe(true);
  });

  it('allows richer network payloads to pass through (observers will add stack/timing fields)', () => {
    const r = parseEventPayload(EventType.NET_REQUEST, {
      id: 'r1',
      method: 'GET',
      url: '/api/x',
      status: 200,
      ok: true,
      durationMs: 12,
      initiator: 'fetch',
      ttfbMs: 5,
      initiatorStack: 'app.ts:9',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a net.request missing its load-bearing fields', () => {
    expect(parseEventPayload(EventType.NET_REQUEST, { url: '/api/x' }).success).toBe(false);
  });

  it('narrows a route.change payload, including how the URL moved', () => {
    const r = parseEventPayload(EventType.ROUTE_CHANGE, {
      from: '/a',
      to: 'http://x/b',
      pathname: '/b',
      search: '',
      hash: '',
      [ROUTE_CHANGE_HOW_FIELD]: RouteChangeHow.REPLACE,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a route.change that omits how, or names one outside push/replace/pop', () => {
    expect(
      parseEventPayload(EventType.ROUTE_CHANGE, {
        from: '/a',
        to: 'http://x/b',
        pathname: '/b',
        search: '',
        hash: '',
      }).success,
    ).toBe(false);
    expect(
      parseEventPayload(EventType.ROUTE_CHANGE, {
        from: '/a',
        to: 'http://x/b',
        pathname: '/b',
        search: '',
        hash: '',
        [ROUTE_CHANGE_HOW_FIELD]: 'navigate',
      }).success,
    ).toBe(false);
  });

  it('reuses the human.mark narrowing (rejects an empty note)', () => {
    expect(
      parseEventPayload(EventType.HUMAN_MARK, { note: '', anchor: 'testid:x', strategy: 'testid' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown net.stream transport', () => {
    expect(
      parseEventPayload(EventType.NET_STREAM, { transport: 'grpc', direction: 'in', url: '/x' })
        .success,
    ).toBe(false);
  });
});

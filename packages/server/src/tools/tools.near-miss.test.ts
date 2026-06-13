import { describe, expect, it } from 'vitest';
import { EventType, type IrisEvent } from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

function ev(type: EventType, data: Record<string, unknown>): IrisEvent {
  return { t: 1, type, sessionId: 's', data };
}

/** A session whose buffer is a fixed event list (the only method the network/console tools use). */
function sessionWith(events: IrisEvent[]): Session {
  const stub: Partial<Session> = {
    id: 'demo',
    eventsSince: () => events,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => undefined as never,
    drainInbox: () => [],
  };
  return stub as Session;
}

function depsWith(events: IrisEvent[]): ToolDeps {
  const session = sessionWith(events);
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('near-miss on iris_network / iris_console', () => {
  it('iris_network: a zero-match filter returns a hint of what DID fire', async () => {
    const deps = depsWith([
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/items', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 500 }),
    ]);
    const r = (await tool(IrisTool.NETWORK).handler(deps, { method: 'DELETE' })) as {
      calls: unknown[];
      hint?: { totalInWindow: number; present: { method: string }[] };
    };
    expect(r.calls).toHaveLength(0);
    expect(r.hint?.totalInWindow).toBe(2);
    expect(r.hint?.present.map((p) => p.method)).toEqual(['POST', 'GET']);
  });

  it('iris_network: a match returns no hint (bare calls)', async () => {
    const deps = depsWith([ev(EventType.NET_REQUEST, { method: 'GET', url: '/a', status: 200 })]);
    const r = (await tool(IrisTool.NETWORK).handler(deps, { method: 'GET' })) as {
      calls: unknown[];
      hint?: unknown;
    };
    expect(r.calls).toHaveLength(1);
    expect(r.hint).toBeUndefined();
  });

  it('iris_network: an empty buffer returns no hint (nothing to describe)', async () => {
    const r = (await tool(IrisTool.NETWORK).handler(depsWith([]), {})) as { hint?: unknown };
    expect(r.hint).toBeUndefined();
  });

  it('iris_console: zero matches at a level report the levels that ARE present', async () => {
    const deps = depsWith([
      ev(EventType.CONSOLE_WARN, { message: 'w' }),
      ev(EventType.CONSOLE_LOG, { message: 'l' }),
    ]);
    const r = (await tool(IrisTool.CONSOLE).handler(deps, { level: 'error' })) as {
      logs: unknown[];
      hint?: { byLevel: { warn: number; log: number; error: number } };
    };
    expect(r.logs).toHaveLength(0);
    expect(r.hint?.byLevel).toEqual({ log: 1, warn: 1, error: 0 });
  });
});

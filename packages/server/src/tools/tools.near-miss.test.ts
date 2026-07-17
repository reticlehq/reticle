import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  return { t: 1, type, sessionId: 's', data };
}

/** A session whose buffer is a fixed event list (the only method the network/console tools use). */
function sessionWith(events: ReticleEvent[]): Session {
  const stub: Partial<Session> = {
    id: 'demo',
    eventsSince: () => events,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
    getState: () => undefined as never,
    drainInbox: () => [],
  };
  return stub as Session;
}

function depsWith(events: ReticleEvent[]): ToolDeps {
  const session = sessionWith(events);
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('near-miss on reticle_network / reticle_console', () => {
  it('reticle_network: a zero-match filter returns a hint of what DID fire', async () => {
    const deps = depsWith([
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/items', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 500 }),
    ]);
    const r = (await tool(ReticleTool.NETWORK).handler(deps, { method: 'DELETE' })) as {
      calls: unknown[];
      hint?: { totalInWindow: number; present: { method: string }[] };
    };
    expect(r.calls).toHaveLength(0);
    expect(r.hint?.totalInWindow).toBe(2);
    expect(r.hint?.present.map((p) => p.method)).toEqual(['POST', 'GET']);
  });

  it('reticle_network: a match returns no hint (bare calls)', async () => {
    const deps = depsWith([ev(EventType.NET_REQUEST, { method: 'GET', url: '/a', status: 200 })]);
    const r = (await tool(ReticleTool.NETWORK).handler(deps, { method: 'GET' })) as {
      calls: unknown[];
      hint?: unknown;
    };
    expect(r.calls).toHaveLength(1);
    expect(r.hint).toBeUndefined();
  });

  it('reticle_network: an empty buffer returns no hint (nothing to describe)', async () => {
    const r = (await tool(ReticleTool.NETWORK).handler(depsWith([]), {})) as { hint?: unknown };
    expect(r.hint).toBeUndefined();
  });

  it('reticle_console: zero matches at a level report the levels that ARE present', async () => {
    const deps = depsWith([
      ev(EventType.CONSOLE_WARN, { message: 'w' }),
      ev(EventType.CONSOLE_LOG, { message: 'l' }),
    ]);
    const r = (await tool(ReticleTool.CONSOLE).handler(deps, { level: 'error' })) as {
      logs: unknown[];
      hint?: { byLevel: { warn: number; log: number; error: number } };
    };
    expect(r.logs).toHaveLength(0);
    expect(r.hint?.byLevel).toEqual({ log: 1, warn: 1, error: 0 });
  });
});

describe('token budget on reticle_network / reticle_console', () => {
  it('reticle_network: limit keeps the most recent N, reporting total + droppedOldest + cost', async () => {
    const deps = depsWith([
      ev(EventType.NET_REQUEST, { url: '/1', status: 200 }),
      ev(EventType.NET_REQUEST, { url: '/2', status: 200 }),
      ev(EventType.NET_REQUEST, { url: '/3', status: 200 }),
    ]);
    const r = (await tool(ReticleTool.NETWORK).handler(deps, { limit: 2 })) as {
      calls: { url: string }[];
      total?: number;
      droppedOldest?: number;
      cost?: { bytes: number };
    };
    expect(r.calls.map((c) => c.url)).toEqual(['/2', '/3']);
    expect(r.total).toBe(3);
    expect(r.droppedOldest).toBe(1);
    expect(r.cost?.bytes).toBeGreaterThan(0);
  });

  it('reticle_network: no limit returns all matches + a cost hint, no total/droppedOldest', async () => {
    const deps = depsWith([ev(EventType.NET_REQUEST, { url: '/1', status: 200 })]);
    const r = (await tool(ReticleTool.NETWORK).handler(deps, {})) as {
      calls: unknown[];
      total?: number;
      droppedOldest?: number;
      cost?: { bytes: number };
    };
    expect(r.calls).toHaveLength(1);
    expect(r.total).toBeUndefined();
    expect(r.droppedOldest).toBeUndefined();
    expect(r.cost?.bytes).toBeGreaterThan(0);
  });

  it('reticle_console: limit keeps the most recent N entries', async () => {
    const deps = depsWith([
      ev(EventType.CONSOLE_ERROR, { message: 'a' }),
      ev(EventType.CONSOLE_ERROR, { message: 'b' }),
      ev(EventType.CONSOLE_ERROR, { message: 'c' }),
    ]);
    const r = (await tool(ReticleTool.CONSOLE).handler(deps, { level: 'error', limit: 1 })) as {
      logs: { text: string }[];
      total?: number;
      droppedOldest?: number;
    };
    expect(r.logs.map((l) => l.text)).toEqual(['c']);
    expect(r.total).toBe(3);
    expect(r.droppedOldest).toBe(2);
  });
});

describe('buffer honesty — a negative result after eviction is not silent', () => {
  /** A session whose ring buffer has evicted `dropped` events since connect. */
  function depsWithDrops(events: ReticleEvent[], dropped: number): ToolDeps {
    const stub: Partial<Session> = {
      id: 'demo',
      eventsSince: () => events,
      eventsInWindow: () => events,
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: events.length, dropped }),
      elapsed: () => 0,
      lastActCursor: () => undefined,
      getState: () => undefined as never,
      drainInbox: () => [],
    };
    const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
    return { sessions: sessions as SessionManager } as ToolDeps;
  }

  it('reticle_network: an empty result WITH evictions carries a buffer block (not a false clean no)', async () => {
    const r = (await tool(ReticleTool.NETWORK).handler(depsWithDrops([], 12), {
      method: 'POST',
    })) as { calls: unknown[]; buffer?: { held: number; dropped: number; note: string } };
    expect(r.calls).toHaveLength(0);
    expect(r.buffer?.dropped).toBe(12);
    expect(r.buffer?.note.length).toBeGreaterThan(0);
  });

  it('reticle_observe / console: an intact buffer (0 drops) omits the block entirely', async () => {
    const net = (await tool(ReticleTool.NETWORK).handler(depsWithDrops([], 0), {})) as {
      buffer?: unknown;
    };
    const obs = (await tool(ReticleTool.OBSERVE).handler(depsWithDrops([], 0), {})) as {
      buffer?: unknown;
    };
    expect(net.buffer).toBeUndefined();
    expect(obs.buffer).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { EventType, SessionState, type ReticleEvent } from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { createMcpServer } from '@/surface/mcp/mcp.js';
import { TOOL_SURFACE } from './tool-surface.js';
import type { ToolDeps } from './tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * `reticle_observe { filters: "net" }` was refused because `filters` had to be an array (#2294).
 * The description says "Use a bucket name", so one string is the natural first call. It is now
 * read as an array of one. A string that holds a JSON array, the way some clients send arrays, is
 * read as that array, and one that starts with `[` but is not an array of strings is refused.
 */
let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

const EVENTS: ReticleEvent[] = [
  ev(EventType.NET_REQUEST, {
    method: 'GET',
    url: 'http://localhost:5173/api/orders',
    status: 200,
  }),
  ev(EventType.DOM_ADDED, { path: 'main > h1', text: 'Orders' }),
  ev(EventType.STATE_CHANGE, { path: 'orders.count', next: 3 }),
];

function deps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    queryEvents: () => Promise.resolve(EVENTS),
    eventsSince: () => EVENTS,
    bufferHealth: () => ({ total: EVENTS.length, dropped: 0 }),
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager, now: () => 0 } as unknown as ToolDeps;
}

interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: { events?: { type: string }[] };
}

/** Calls `reticle_observe` through a real MCP client, so the advertised schema validates the call. */
async function observe(args: Record<string, unknown>): Promise<CallResult> {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(deps(), TOOL_SURFACE.DEFAULT, false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: 'reticle_observe',
      arguments: { since: 0, ...args },
    })) as CallResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const types = (result: CallResult): string[] =>
  (result.structuredContent?.events ?? []).map((e) => e.type);

const text = (result: CallResult): string => (result.content ?? []).map((c) => c.text).join('\n');

describe('reticle_observe filters takes one bucket name as a string', () => {
  it('accepts filters: "net" and returns only the net events', async () => {
    const result = await observe({ filters: 'net' });
    expect(result.isError, text(result)).not.toBe(true);
    expect(types(result)).toEqual([EventType.NET_REQUEST]);
  });

  it('returns the same events for "state" as for ["state"]', async () => {
    const single = await observe({ filters: 'state' });
    const list = await observe({ filters: ['state'] });
    expect(single.isError, text(single)).not.toBe(true);
    expect(types(single)).toEqual(types(list));
    expect(types(single)).toEqual([EventType.STATE_CHANGE]);
  });

  it('reads a string that holds a JSON array as that array', async () => {
    const result = await observe({ filters: '["net","dom"]' });
    expect(result.isError, text(result)).not.toBe(true);
    expect(types(result)).toEqual([EventType.NET_REQUEST, EventType.DOM_ADDED]);
  });

  it('accepts one raw event type as a string', async () => {
    const result = await observe({ filters: EventType.NET_REQUEST });
    expect(result.isError, text(result)).not.toBe(true);
    expect(types(result)).toEqual([EventType.NET_REQUEST]);
  });

  // Taken as one filter name, these match nothing and answer an empty timeline without a word,
  // which reads as "the app did nothing". The array-only schema refused them; they stay refused.
  it.each(['net, console', 'net,console', 'net | console', 'NET', ''])(
    'refuses %j, which names no bucket and no event type',
    async (filters) => {
      const result = await observe({ filters });
      expect(result.isError, text(result)).toBe(true);
      expect(text(result)).toContain('reticle_observe filters');
      expect(text(result)).toContain('net');
    },
  );

  it.each(['[net', '[1]'])(
    'refuses %j, which starts with [ but is not an array of strings',
    async (filters) => {
      const result = await observe({ filters });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('reticle_observe filters');
    },
  );

  // A malformed argument is the caller's mistake: the answer must not ask for a defect report.
  it('refuses a bad filters string as an invalid call, not as a Reticle defect', async () => {
    for (const filters of ['[1]', 'net, console']) {
      const result = await observe({ filters });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('may be a defect');
    }
  });
});

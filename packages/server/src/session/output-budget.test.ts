import { describe, it, expect } from 'vitest';
import { EventType, SessionState, type IrisEvent } from '@syrin/iris-protocol';
import {
  applyEventBudget,
  costHint,
  estimateTokens,
  sizeCost,
  withSizeCost,
} from './output-budget.js';
import { TOOLS } from '../tools/tools.js';
import { IrisTool } from '../tools/tool-names.js';
import type { Session, SessionManager } from './session.js';
import type { ToolDeps } from '../tools/tools.js';

function ev(t: number): IrisEvent {
  return { t, type: EventType.DOM_ADDED, sessionId: 's', data: { i: t } };
}

describe('applyEventBudget', () => {
  it('keeps every event when no cap is set', () => {
    const events = [ev(1), ev(2), ev(3)];
    const r = applyEventBudget(events, undefined);
    expect(r.events).toHaveLength(3);
    expect(r.droppedOldest).toBe(0);
  });

  it('keeps the most recent N and reports how many older were dropped', () => {
    const events = [ev(1), ev(2), ev(3), ev(4), ev(5)];
    const r = applyEventBudget(events, 2);
    expect(r.events.map((e) => e.t)).toEqual([4, 5]);
    expect(r.droppedOldest).toBe(3);
  });
});

describe('costHint', () => {
  it('reports event count and a byte size', () => {
    const c = costHint({ a: 1 }, 3);
    expect(c.events).toBe(3);
    expect(c.bytes).toBeGreaterThan(0);
    expect(c.droppedOldest).toBeUndefined();
  });

  it('includes droppedOldest only when something was dropped', () => {
    expect(costHint({}, 1, 4).droppedOldest).toBe(4);
  });

  it('adds no recommendation for a small timeline', () => {
    expect(costHint({ a: 1 }, 5).recommendation).toBeUndefined();
  });

  it('recommends scoping when the event count is large (observed: login flooded ~319)', () => {
    const c = costHint({ a: 1 }, 319);
    expect(c.recommendation).toBeDefined();
    expect(c.recommendation).toContain('filters');
    expect(c.recommendation).toContain('319');
  });

  it('recommends scoping when the byte size is large even with few events', () => {
    const big = { blob: 'x'.repeat(9000) };
    const c = costHint(big, 3);
    expect(c.recommendation).toBeDefined();
  });
});

describe('estimateTokens', () => {
  it('is ~chars/4 and grows with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(1000))).toBeGreaterThan(estimateTokens('a'.repeat(100)));
  });
});

describe('sizeCost / withSizeCost', () => {
  it('reports bytes + an estimated token count for a payload', () => {
    const c = sizeCost({ tree: 'a'.repeat(400) });
    expect(c.bytes).toBeGreaterThan(400);
    expect(c.tokens).toBeGreaterThan(0);
  });

  it('attaches cost to an object result without dropping fields', () => {
    const r = withSizeCost({ tree: 'x', status: { route: '/' } }) as {
      tree: string;
      status: { route: string };
      cost: { bytes: number; tokens: number };
    };
    expect(r.tree).toBe('x');
    expect(r.status.route).toBe('/');
    expect(r.cost.bytes).toBeGreaterThan(0);
    expect(r.cost.tokens).toBeGreaterThanOrEqual(1);
  });

  it('measures the body, not including the cost field it adds', () => {
    const big = withSizeCost({ tree: 'a'.repeat(4000) }) as unknown as {
      cost: { tokens: number };
    };
    // ~4000 chars of tree + JSON overhead → ~1000 tokens, not inflated by the cost object itself.
    expect(big.cost.tokens).toBeGreaterThan(900);
    expect(big.cost.tokens).toBeLessThan(1100);
  });

  it('passes non-object results through unchanged', () => {
    expect(withSizeCost(null)).toBeNull();
    expect(withSizeCost('err')).toBe('err');
  });
});

// ── observe wiring ────────────────────────────────────────────────────────────
function fakeDeps(events: IrisEvent[]): ToolDeps {
  const stub: Partial<Session> = {
    id: 'demo',
    eventsInWindow: () => events,
    eventsSince: () => events,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function observeTool() {
  const tool = TOOLS.find((t) => t.name === IrisTool.OBSERVE);
  if (tool === undefined) throw new Error('no iris_observe tool');
  return tool;
}

describe('iris_observe output budget', () => {
  it('always returns a cost hint with events + bytes', async () => {
    const deps = fakeDeps([ev(1), ev(2)]);
    const res = (await observeTool().handler(deps, {})) as {
      cost?: { events: number; bytes: number };
    };
    expect(res.cost?.events).toBe(2);
    expect(res.cost?.bytes).toBeGreaterThan(0);
  });

  it('caps events to max_events (most recent) and reports droppedOldest', async () => {
    const deps = fakeDeps([ev(1), ev(2), ev(3), ev(4)]);
    const res = (await observeTool().handler(deps, { max_events: 1 })) as {
      events: IrisEvent[];
      cost?: { events: number; droppedOldest?: number };
    };
    expect(res.events.map((e) => e.t)).toEqual([4]);
    expect(res.cost?.events).toBe(1);
    expect(res.cost?.droppedOldest).toBe(3);
  });
});

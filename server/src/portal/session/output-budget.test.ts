import { describe, it, expect } from 'vitest';
import { LastAct } from './last-act.js';
import { EventType, SessionState, type ReticleEvent } from '@reticlehq/core';
import {
  applyEventBudget,
  costHint,
  DEFAULT_OBSERVE_EVENT_LIMIT,
  estimateTokens,
  sizeCost,
  withSizeCost,
} from './output-budget.js';
import { TOOLS } from '../../surface/tools/tools.js';
import { ReticleTool } from '@reticlehq/core';
import type { Session, SessionManager } from './session.js';
import type { ToolDeps } from '../../surface/tools/tools.js';

function ev(t: number): ReticleEvent {
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

  it('reports UTF-8 bytes, not UTF-16 code units, for multibyte content', () => {
    // Japanese characters are 3 bytes each in UTF-8, 2 code units in UTF-16
    const c = sizeCost({ text: '日本語' });
    expect(c.bytes).toBe(Buffer.byteLength(JSON.stringify({ text: '日本語' }), 'utf8'));
    expect(c.bytes).toBeGreaterThan(JSON.stringify({ text: '日本語' }).length);
  });

  it('passes non-object results through unchanged', () => {
    expect(withSizeCost(null)).toBeNull();
    expect(withSizeCost('err')).toBe('err');
  });
});

// ── observe wiring ────────────────────────────────────────────────────────────
function fakeDeps(events: ReticleEvent[]): ToolDeps {
  const stub: Partial<Session> = {
    id: 'demo',
    elapsed: () => 0,
    lastAct: new LastAct(),
    eventsInWindow: () => events,
    eventsSince: () => events,
    queryEvents: () => Promise.resolve(events),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
    blindSpots: () => ({}),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function observeTool() {
  const tool = TOOLS.find((t) => t.name === ReticleTool.OBSERVE);
  if (tool === undefined) throw new Error('no reticle_observe tool');
  return tool;
}

describe('reticle_observe output budget', () => {
  it('always returns a cost hint with events + bytes', async () => {
    const deps = fakeDeps([ev(1), ev(2)]);
    const res = (await observeTool().handler(deps, {})) as {
      cost?: { events: number; bytes: number };
    };
    expect(res.cost?.events).toBe(2);
    expect(res.cost?.bytes).toBeGreaterThan(0);
  });

  it('caps an unbounded timeline to the default limit when the caller passes no max_events', async () => {
    // The pathological case this guards: a page whose animations emit an event per frame. Without a
    // default the whole timeline is returned, which was measured at 60KB in a single tool result.
    const many = Array.from({ length: DEFAULT_OBSERVE_EVENT_LIMIT + 50 }, (_, i) => ev(i + 1));
    const res = (await observeTool().handler(fakeDeps(many), {})) as {
      events: ReticleEvent[];
      cost?: { events: number; droppedOldest?: number };
    };
    expect(res.events.length).toBe(DEFAULT_OBSERVE_EVENT_LIMIT);
    // Nothing is hidden: the agent is told how many older events fell outside the cap.
    expect(res.cost?.droppedOldest).toBe(50);
    // The most recent event is kept, not the oldest.
    expect(res.events[res.events.length - 1]?.t).toBe(DEFAULT_OBSERVE_EVENT_LIMIT + 50);
  });

  it('lets an explicit max_events raise the cap above the default', async () => {
    const many = Array.from({ length: DEFAULT_OBSERVE_EVENT_LIMIT + 50 }, (_, i) => ev(i + 1));
    const res = (await observeTool().handler(fakeDeps(many), {
      max_events: DEFAULT_OBSERVE_EVENT_LIMIT + 50,
    })) as { events: ReticleEvent[]; cost?: { droppedOldest?: number } };
    expect(res.events.length).toBe(DEFAULT_OBSERVE_EVENT_LIMIT + 50);
    expect(res.cost?.droppedOldest).toBeUndefined();
  });

  it('caps events to max_events (most recent) and reports droppedOldest', async () => {
    const deps = fakeDeps([ev(1), ev(2), ev(3), ev(4)]);
    const res = (await observeTool().handler(deps, { max_events: 1 })) as {
      events: ReticleEvent[];
      cost?: { events: number; droppedOldest?: number };
    };
    expect(res.events.map((e) => e.t)).toEqual([4]);
    expect(res.cost?.events).toBe(1);
    expect(res.cost?.droppedOldest).toBe(3);
  });
});

describe('the budget sacrifices noise before evidence', () => {
  /**
   * Found by driving a real session, not by reading code.
   *
   * A live page emits a health heartbeat every few seconds forever. In a two-second window on a
   * quiet app, a real observe call came back with 200 events, 46 KB, and this summary: zero network,
   * zero DOM changes, zero route changes, zero console errors, zero signals. Every single event was
   * a heartbeat.
   *
   * Keeping "the most recent N" is what caused that. Heartbeats are the most recent thing on any
   * idle page, so a recency-only cap fills the whole budget with them and throws away the click that
   * happened thirty seconds ago -- which is the one thing the caller asked about.
   *
   * Core already knows which events are noise: CHURN_TYPES exists and its comment calls them "the
   * ONLY thing that should be sacrificed when a buffer is full". That rule was applied to buffer
   * eviction and not to this budget. Now it is applied to both.
   */
  const heartbeat = (t: number): ReticleEvent =>
    ({ t, type: EventType.PAGE_HEALTH, seq: t, data: {} }) as unknown as ReticleEvent;
  const click = (t: number): ReticleEvent =>
    ({ t, type: EventType.DOM_ADDED, seq: t, data: {} }) as unknown as ReticleEvent;

  it('keeps the evidence and drops the heartbeats when it cannot keep both', () => {
    // One real event, then a flood of heartbeats. Recency alone would lose the real one.
    const events = [click(1), ...Array.from({ length: 10 }, (_, i) => heartbeat(i + 2))];
    const { events: kept, droppedOldest } = applyEventBudget(events, 3);
    expect(kept.length).toBe(3);
    expect(
      kept.some((e) => e.type === EventType.DOM_ADDED),
      'the click must survive',
    ).toBe(true);
    expect(droppedOldest).toBe(8);
  });

  it('still returns events oldest-first, so the timeline reads in order', () => {
    const events = [click(1), heartbeat(2), click(3), heartbeat(4)];
    const { events: kept } = applyEventBudget(events, 3);
    expect(kept.map((e) => e.t)).toEqual([...kept.map((e) => e.t)].sort((a, b) => a - b));
  });

  it('keeps the most recent evidence when evidence alone overflows the budget', () => {
    const events = [click(1), click(2), click(3), click(4)];
    const { events: kept } = applyEventBudget(events, 2);
    expect(kept.map((e) => e.t)).toEqual([3, 4]);
  });

  it('still fills spare room with the most recent noise', () => {
    const events = [click(1), heartbeat(2), heartbeat(3), heartbeat(4)];
    const { events: kept } = applyEventBudget(events, 3);
    expect(kept.map((e) => e.t)).toEqual([1, 3, 4]);
  });
});

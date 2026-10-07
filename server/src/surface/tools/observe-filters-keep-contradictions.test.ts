import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, SessionState, type ReticleEvent } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * `filters` and `max_events` shape what `reticle_observe` RETURNS, never what it concludes (#1359).
 *
 * Contradictions were computed over the filtered window, so `filters: ["route"]` removed the DOM
 * events proving the destination rendered and the call reported `route-rendered-nothing`, which the
 * unfiltered call on the same window did not. Agents read it as an app defect.
 */
let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

/** A navigation whose destination rendered: a route change, then content added. */
const renderedNavigation = (): ReticleEvent[] => [
  ev(EventType.ROUTE_CHANGE, { from: '/', to: '/invoices', url: 'http://localhost:5173/invoices' }),
  ev(EventType.DOM_ADDED, { path: 'main > h1', text: 'Invoices' }),
];

/** A navigation that rendered nothing: the true positive the rule exists for. */
const blankNavigation = (): ReticleEvent[] => [
  ev(EventType.ROUTE_CHANGE, { from: '/', to: '/reports', url: 'http://localhost:5173/reports' }),
];

function deps(events: ReticleEvent[]): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    queryEvents: () => Promise.resolve(events),
    eventsSince: () => events,
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager, now: () => 0 } as unknown as ToolDeps;
}

async function kinds(events: ReticleEvent[], args: Record<string, unknown>): Promise<string[]> {
  const out = (await TOOLS.find((t) => t.name === ReticleTool.OBSERVE)?.handler(deps(events), {
    since: 0,
    ...args,
  })) as { contradictions?: { kind: string }[] };
  return (out.contradictions ?? []).map((c) => c.kind).sort();
}

describe('observe concludes from the whole window, whatever it returns', () => {
  it('gives the same contradictions with filters: ["route"] as without', async () => {
    const events = renderedNavigation();
    expect(await kinds(events, { filters: ['route'] })).toEqual(await kinds(events, {}));
  });

  it('reports no route-rendered-nothing for a filtered observe after a rendered navigation', async () => {
    expect(await kinds(renderedNavigation(), { filters: ['route'] })).not.toContain(
      ContradictionKind.ROUTE_RENDERED_NOTHING,
    );
  });

  it('is not changed by max_events either', async () => {
    const events = renderedNavigation();
    expect(await kinds(events, { max_events: 1 })).toEqual(await kinds(events, {}));
  });

  it('still reports a navigation that rendered nothing, filtered or not', async () => {
    expect(await kinds(blankNavigation(), {})).toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
    expect(await kinds(blankNavigation(), { filters: ['route'] })).toContain(
      ContradictionKind.ROUTE_RENDERED_NOTHING,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  EventType,
  JOURNAL_FILE_VERSION,
  PhenomenonType,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  detectDeadClicks,
  detectHidden500,
  detectHungRequests,
  detectPhenomena,
  detectPreHydrationClicks,
  detectSwallowedErrors,
} from './phenomena.js';
import { RETICLE_ERROR_BOUNDARY_SIGNAL, RETICLE_HYDRATION_SIGNAL } from '@reticlehq/core';

let seq = 0;
function e(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}
function action(over: Partial<JournalAction>): JournalAction {
  return {
    v: JOURNAL_FILE_VERSION,
    actionId: 'a1',
    tool: 'reticle_act',
    args: {},
    tRange: { from: 0, to: 1 },
    at: 0,
    ...over,
  };
}

describe('detectHungRequests', () => {
  it('flags a NET_PENDING with no matching completion', () => {
    const events = [
      e(EventType.NET_PENDING, { id: 'n1', method: 'GET', url: '/a' }),
      e(EventType.NET_PENDING, { id: 'n2', method: 'POST', url: '/b' }),
      e(EventType.NET_REQUEST, { id: 'n1', status: 200 }),
    ];
    const findings = detectHungRequests(events);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      phenomenon: PhenomenonType.HUNG_REQUEST,
      evidence: { id: 'n2', url: '/b' },
    });
  });
});

describe('detectHidden500', () => {
  it('flags a 5xx that lands while the page is hidden, not while visible', () => {
    const events = [
      e(EventType.NET_REQUEST, { id: 'n1', url: '/visible', status: 500 }), // visible → not flagged
      e(EventType.PAGE_HEALTH, { hidden: true, focused: false }),
      e(EventType.NET_REQUEST, { id: 'n2', url: '/bg', status: 503 }), // hidden → flagged
      e(EventType.PAGE_HEALTH, { hidden: false, focused: true }),
      e(EventType.NET_REQUEST, { id: 'n3', url: '/ok', status: 200 }),
    ];
    const findings = detectHidden500(events);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toMatchObject({ url: '/bg', status: 503 });
  });
});

describe('detectDeadClicks', () => {
  it('flags a click action that attributed no events', () => {
    const actions = [
      action({ actionId: 'a1', tool: 'reticle_act', seqRange: { from: 0, to: 3 } }), // caused events
      action({ actionId: 'a2', tool: 'reticle_act' }), // no seqRange → dead
      action({ actionId: 'a3', tool: 'reticle_navigate' }), // navigate, not a click
    ];
    const findings = detectDeadClicks(actions);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      phenomenon: PhenomenonType.DEAD_CLICK,
      evidence: { actionId: 'a2' },
    });
  });
});

describe('detectPreHydrationClicks', () => {
  const hydrationAt = (t: number): ReticleEvent => {
    seq += 1;
    return {
      t,
      seq,
      type: EventType.SIGNAL,
      sessionId: 'demo',
      data: { name: RETICLE_HYDRATION_SIGNAL },
    };
  };

  it('flags a click dispatched before the hydration-complete signal', () => {
    const events = [hydrationAt(100)];
    const actions = [
      action({ actionId: 'a1', tool: 'reticle_act', tRange: { from: 40, to: 45 } }), // before hydration
      action({ actionId: 'a2', tool: 'reticle_act', tRange: { from: 150, to: 155 } }), // after hydration
    ];
    const findings = detectPreHydrationClicks(events, actions);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      phenomenon: PhenomenonType.PRE_HYDRATION_CLICK,
      evidence: { actionId: 'a1' },
    });
  });

  it('does not guess when there is no hydration signal (not a React app)', () => {
    const actions = [action({ actionId: 'a1', tool: 'reticle_act', tRange: { from: 10, to: 15 } })];
    expect(detectPreHydrationClicks([], actions)).toEqual([]);
  });
});

describe('detectSwallowedErrors', () => {
  it('flags an error-boundary signal, carrying its detail as evidence', () => {
    const events = [
      e(EventType.SIGNAL, {
        name: RETICLE_ERROR_BOUNDARY_SIGNAL,
        data: { message: 'render blew up' },
      }),
    ];
    const findings = detectSwallowedErrors(events);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      phenomenon: PhenomenonType.SWALLOWED_ERROR,
      evidence: { message: 'render blew up' },
    });
  });

  it('ignores ordinary app signals', () => {
    expect(detectSwallowedErrors([e(EventType.SIGNAL, { name: 'order:placed' })])).toEqual([]);
  });
});

describe('detectPhenomena', () => {
  it('runs every journal-only matcher and returns nothing on a clean session', () => {
    expect(detectPhenomena([], [])).toEqual([]);
  });
});

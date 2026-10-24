/**
 * `reticle_map`'s fold: a project's journaled sessions as one App Graph, and its screens counted.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { graphOfSessions, screensOf } from './map-tools.js';

const ev = (type: string, t: number, data: Record<string, unknown> = {}): ReticleEvent =>
  ({ type, t, data }) as unknown as ReticleEvent;
const act = (testid: string, from: number, to: number, verified?: string): JournalAction => ({
  v: 1,
  actionId: `a${String(from)}`,
  tool: 'reticle_act_and_wait',
  args: { target: { testid }, action: 'click' },
  tRange: { from, to },
  at: from,
  ...(verified === undefined ? {} : { effect: { verified } }),
});

describe('the map a project has journaled', () => {
  it('folds every session into one graph: screens, the controls pressed on them, and what held', () => {
    const first = {
      id: 's1',
      actions: [act('nav-memory', 100, 200, 'yes')],
      events: [
        ev(EventType.ROUTE_CHANGE, 5, { pathname: '/' }),
        ev(EventType.ROUTE_CHANGE, 150, { pathname: '/memory' }),
      ],
    };
    const second = {
      id: 's2',
      actions: [act('memory-add-fact', 300, 400)],
      events: [ev(EventType.ROUTE_CHANGE, 250, { pathname: '/memory' })],
    };
    const map = graphOfSessions([first, second]);
    expect(map).toBeDefined();
    const screens = screensOf(map ?? { nodes: [], edges: [] });
    expect(screens.find((s) => '/' === s.screen)).toMatchObject({
      actions: 1,
      pressed: 1,
      proven: 1,
    });
    expect(screens.find((s) => '/memory' === s.screen)).toMatchObject({
      actions: 1,
      pressed: 1,
      proven: 0,
    });
  });

  it('is nothing when no session pressed anything', () => {
    expect(graphOfSessions([])).toBeUndefined();
  });
});

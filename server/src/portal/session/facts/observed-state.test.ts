import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { ObservedState } from './observed-state.js';

describe('ambient persistence does not double per session', () => {
  it('ownAmbientCounts EXCLUDES the seeded map', () => {
    // The defect: seeding merged history into the same map teardown persists, so every run wrote
    // `2 x persisted + own`. Compounding over ~80 sessions drove the committed .reticle/ambient.json
    // to ~9.1e23. Separating the seed makes accumulation mean "history plus what is new".
    const state = new ObservedState();
    state.seedAmbient({ 'chat-log': 100 });
    state.observe({ t: 1, type: EventType.DOM_TEXT, sessionId: 's', data: { region: 'chat-log' } });
    // Own carries this session's single observation and NOT the 100 it was seeded with. Teardown adds
    // this onto the file it loaded, so the seeded 100 is counted exactly once, by the file itself.
    expect(state.ownAmbientCounts()['chat-log']).toBe(1);
    expect(state.ambientCounts()['chat-log']).toBe(101);
  });

  it('ambientCounts still SEES the seed, so the settle oracle keeps its sharper picture', () => {
    const state = new ObservedState();
    state.seedAmbient({ 'chat-log': 100 });
    expect(state.ambientCounts()['chat-log']).toBe(100);
  });

  it('simulating N teardowns stays linear, not exponential', () => {
    // The property that actually matters: replay the load -> seed -> observe -> persist loop and the
    // total must grow by a constant per round, never multiply.
    let persisted: Record<string, number> = {};
    for (let round = 0; round < 12; round++) {
      const state = new ObservedState();
      state.seedAmbient(persisted);
      state.observe({
        t: 1,
        type: EventType.DOM_TEXT,
        sessionId: 's',
        data: { region: 'chat-log' },
      });
      const merged: Record<string, number> = { ...persisted };
      for (const [k, v] of Object.entries(state.ownAmbientCounts()))
        merged[k] = (merged[k] ?? 0) + v;
      persisted = merged;
    }
    const total = Object.values(persisted).reduce((a, b) => a + b, 0);
    expect(total).toBe(12); // one observation per round; doubling would give 2^12 - 1 = 4095
  });
});

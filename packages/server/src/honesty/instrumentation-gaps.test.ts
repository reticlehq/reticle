import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind } from '@reticlehq/core';
import { gapsForAction, type ActionInstrumentationFacts } from './instrumentation-gaps.js';

const clean: ActionInstrumentationFacts = {
  pass: true,
  sourceKnown: true,
  stateAsked: false,
  stateUnwatched: false,
  domMutated: false,
  signalsFired: 1,
  routeChanged: false,
  routeSignalFired: false,
};

const kinds = (facts: Partial<ActionInstrumentationFacts>): string[] =>
  gapsForAction({ ...clean, ...facts }).map((g) => g.kind);

describe('gapsForAction', () => {
  it('reports nothing when the app told Reticle everything it needed', () => {
    expect(gapsForAction(clean)).toEqual([]);
  });

  /**
   * THE rule, and the one most likely to erode. A gap is a finding only when the verdict came back
   * weaker BECAUSE of it. A gap nobody hit is a backlog, and a backlog reported as a finding is how
   * an agent learns to stop reading findings.
   */
  describe('only fires when the absence changed the answer', () => {
    it('says nothing about a missing source mapping on a verdict that passed', () => {
      expect(kinds({ pass: true, sourceKnown: false })).toEqual([]);
    });

    it('reports it on a verdict that did NOT pass, where the line is what the agent wants next', () => {
      expect(kinds({ pass: false, sourceKnown: false })).toEqual([
        InstrumentationGapKind.NO_SOURCE_MAPPING,
      ]);
    });

    it('says nothing when the element HAS a source and the verdict failed', () => {
      expect(kinds({ pass: false })).toEqual([]);
    });

    it('says nothing about stores unless the caller actually asked about state', () => {
      expect(kinds({ stateUnwatched: true, stateAsked: false })).toEqual([]);
      expect(kinds({ stateUnwatched: true, stateAsked: true })).toEqual([
        InstrumentationGapKind.NO_STORE_REGISTERED,
      ]);
    });

    /**
     * A mutation with no signal only costs something when Reticle had to INFER the outcome. If the
     * app proved it another way, nothing was lost and there is nothing to ask for.
     */
    it('says nothing about a silent mutation when the verdict was proved anyway', () => {
      expect(kinds({ domMutated: true, signalsFired: 0, pass: true, proved: true })).toEqual([]);
    });

    it('reports a silent mutation when the verdict was not proved', () => {
      expect(kinds({ domMutated: true, signalsFired: 0, pass: false })).toEqual([
        InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
      ]);
    });

    it('says nothing when the DOM did not move at all', () => {
      expect(kinds({ domMutated: false, signalsFired: 0, pass: false })).toEqual([]);
    });

    it('reports a route change nothing signalled', () => {
      expect(kinds({ routeChanged: true, routeSignalFired: false, pass: false })).toEqual([
        InstrumentationGapKind.NO_ROUTE_SIGNAL,
      ]);
    });

    it('says nothing when the route change WAS signalled', () => {
      expect(kinds({ routeChanged: true, routeSignalFired: true, pass: false })).toEqual([]);
    });
  });

  it('carries the ref and the remedy, so the agent can act without another call', () => {
    const [gap] = gapsForAction({ ...clean, pass: false, sourceKnown: false, ref: 'e12' });
    expect(gap?.ref).toBe('e12');
    expect(gap?.fix).toContain('plugin');
    expect(gap?.cost.length ?? 0).toBeGreaterThan(0);
  });

  it('reports several distinct gaps from one action', () => {
    expect(
      kinds({
        pass: false,
        sourceKnown: false,
        domMutated: true,
        signalsFired: 0,
        routeChanged: true,
        routeSignalFired: false,
      }).sort(),
    ).toEqual(
      [
        InstrumentationGapKind.NO_ROUTE_SIGNAL,
        InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
        InstrumentationGapKind.NO_SOURCE_MAPPING,
      ].sort(),
    );
  });
});

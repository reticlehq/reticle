import { describe, it, expect } from 'vitest';
import {
  ConsequenceKind,
  PresenceKind,
  isConsequenceKind,
  isPresenceKind,
  flowExpectHasConsequence,
  flowExpectIsPresenceOnly,
} from './consequence.js';
import type { FlowExpect } from './flow-types.js';

describe('consequence classification (the moat rule, single source)', () => {
  it('signal/net/state are consequences; element/text are presence', () => {
    for (const k of Object.values(ConsequenceKind)) {
      expect(isConsequenceKind(k)).toBe(true);
      expect(isPresenceKind(k)).toBe(false);
    }
    for (const k of Object.values(PresenceKind)) {
      expect(isPresenceKind(k)).toBe(true);
      expect(isConsequenceKind(k)).toBe(false);
    }
  });

  it('route/console/settled/animation are neither consequence nor presence', () => {
    for (const k of ['route', 'console', 'settled', 'animation']) {
      expect(isConsequenceKind(k)).toBe(false);
      expect(isPresenceKind(k)).toBe(false);
    }
  });

  it('flowExpectHasConsequence tracks any consequence field', () => {
    const signal: FlowExpect = { signal: 'saved' };
    const net: FlowExpect = { net: { urlContains: '/api' } };
    const state: FlowExpect = { state: { path: 'x', equals: 1 } };
    const element: FlowExpect = { element: { testid: 'ok' } };
    expect(flowExpectHasConsequence(signal)).toBe(true);
    expect(flowExpectHasConsequence(net)).toBe(true);
    expect(flowExpectHasConsequence(state)).toBe(true);
    expect(flowExpectHasConsequence(element)).toBe(false);
    expect(flowExpectHasConsequence(undefined)).toBe(false);
  });

  it('flowExpectIsPresenceOnly is element-only with no consequence', () => {
    const element: FlowExpect = { element: { testid: 'ok' } };
    const mixed: FlowExpect = { element: { testid: 'ok' }, signal: 'saved' };
    const signal: FlowExpect = { signal: 'saved' };
    expect(flowExpectIsPresenceOnly(element)).toBe(true);
    expect(flowExpectIsPresenceOnly(mixed)).toBe(false);
    expect(flowExpectIsPresenceOnly(signal)).toBe(false);
    expect(flowExpectIsPresenceOnly(undefined)).toBe(false);
  });
});

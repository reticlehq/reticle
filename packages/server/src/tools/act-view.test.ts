import { describe, expect, it } from 'vitest';
import { leanActResult } from './act-view.js';

describe('leanActResult', () => {
  it('drops default-valued effect noise (success and false/null defaults) but keeps the consequence signal', () => {
    const r = leanActResult({
      ok: true,
      action: 'click',
      effect: {
        dispatched: true,
        targetMatched: true,
        visible: true,
        enabled: true,
        focusMoved: 'null->e17',
        domMutatedWithin: 8,
        defaultPrevented: false,
        valueChanged: false,
        occluded: false,
        occludedBy: null,
        scrolledIntoView: false,
      },
    }) as { effect: Record<string, unknown> };
    // A clean, successful action collapses to just its consequence: dispatched/targetMatched/
    // visible/enabled are all at their uninformative success default (true) and drop out.
    expect(r.effect).toEqual({
      focusMoved: 'null->e17',
      domMutatedWithin: 8,
    });
  });

  it('drops focusMoved when null (the no-focus-change default)', () => {
    const r = leanActResult({
      effect: { targetMatched: true, focusMoved: null, domMutatedWithin: 0 },
    }) as { effect: Record<string, unknown> };
    expect(r.effect).toEqual({ domMutatedWithin: 0 });
  });

  it('keeps a success field when it carries signal (the negative case)', () => {
    const r = leanActResult({
      effect: { targetMatched: false, visible: false, enabled: false, domMutatedWithin: 0 },
    }) as { effect: Record<string, unknown> };
    expect(r.effect).toEqual({
      targetMatched: false,
      visible: false,
      enabled: false,
      domMutatedWithin: 0,
    });
  });

  it('keeps a noisy field when it carries signal (true / non-null)', () => {
    const r = leanActResult({
      effect: { occluded: true, occludedBy: 'e9', defaultPrevented: true, valueChanged: true },
    }) as { effect: Record<string, unknown> };
    expect(r.effect).toEqual({
      occluded: true,
      occludedBy: 'e9',
      defaultPrevented: true,
      valueChanged: true,
    });
  });

  it('passes non-objects and effect-less results through unchanged', () => {
    expect(leanActResult(null)).toBeNull();
    expect(leanActResult('x')).toBe('x');
    expect(leanActResult({ ok: true })).toEqual({ ok: true });
  });
});

import { describe, expect, it } from 'vitest';
import { leanActResult } from './act-view.js';

describe('leanActResult', () => {
  it('drops default-valued effect noise but keeps the consequence signal', () => {
    const r = leanActResult({
      ok: true,
      action: 'click',
      effect: {
        targetMatched: true,
        visible: true,
        focusMoved: 'null->e17',
        domMutatedWithin: 8,
        defaultPrevented: false,
        valueChanged: false,
        occluded: false,
        occludedBy: null,
        scrolledIntoView: false,
      },
    }) as { effect: Record<string, unknown> };
    expect(r.effect).toEqual({
      targetMatched: true,
      visible: true,
      focusMoved: 'null->e17',
      domMutatedWithin: 8,
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

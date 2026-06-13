import { describe, expect, it } from 'vitest';
import { boxCenter, isPointerAction } from './real-input.js';

describe('real-input pure helpers', () => {
  it('boxCenter returns the geometric center in CSS px', () => {
    expect(boxCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ cx: 60, cy: 40 });
  });

  it('boxCenter handles a box at the origin', () => {
    expect(boxCenter({ x: 0, y: 0, width: 200, height: 100 })).toEqual({ cx: 100, cy: 50 });
  });

  it('boxCenter handles negative offsets (scrolled above viewport)', () => {
    expect(boxCenter({ x: -40, y: -20, width: 80, height: 40 })).toEqual({ cx: 0, cy: 0 });
  });

  it('isPointerAction is true for hover/click/dblclick/drag', () => {
    for (const action of ['hover', 'click', 'dblclick', 'drag']) {
      expect(isPointerAction(action)).toBe(true);
    }
  });

  it('isPointerAction is false for keyboard/value actions', () => {
    for (const action of [
      'fill',
      'type',
      'focus',
      'blur',
      'check',
      'uncheck',
      'select',
      'submit',
      'press',
      'scrollIntoView',
    ]) {
      expect(isPointerAction(action)).toBe(false);
    }
  });
});

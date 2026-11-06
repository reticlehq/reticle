import { describe, it, expect } from 'vitest';
import { ActionType } from './constants/constants.js';
import {
  ACT_POINT_ARG,
  ClickButton,
  DRAG_TO_POINT_ARG,
  actPointProblem,
  boxFractionFromArgs,
  clickButtonFromArgs,
  clickInputProblem,
  pointInBox,
} from './click-input.js';

describe('clickButtonFromArgs', () => {
  it('defaults to the left button', () => {
    expect(clickButtonFromArgs({})).toBe(ClickButton.LEFT);
  });
  it('reads left, middle and right, ignoring case', () => {
    expect(clickButtonFromArgs({ button: 'right' })).toBe(ClickButton.RIGHT);
    expect(clickButtonFromArgs({ button: 'Middle' })).toBe(ClickButton.MIDDLE);
  });
  it('returns undefined for a name it does not know', () => {
    expect(clickButtonFromArgs({ button: 'back' })).toBeUndefined();
  });
});

describe('clickInputProblem', () => {
  it('accepts a click with known modifiers and a known button', () => {
    expect(
      clickInputProblem(ActionType.CLICK, { modifiers: ['Shift', 'cmd'], button: 'right' }),
    ).toBeUndefined();
  });
  it('refuses a button it does not know', () => {
    expect(clickInputProblem(ActionType.CLICK, { button: 'back' })).toMatch(/button/);
  });
  it('refuses a modifier it does not know', () => {
    expect(clickInputProblem(ActionType.CLICK, { modifiers: ['Hyper'] })).toMatch(/Hyper/);
  });
  it('refuses a double click with a button other than left', () => {
    expect(clickInputProblem(ActionType.DBLCLICK, { button: 'right' })).toMatch(/dblclick/);
  });
});

describe('boxFractionFromArgs', () => {
  it('reads a point as fractions of the box, and nothing when it is absent', () => {
    expect(boxFractionFromArgs({ at: { x: 0.25, y: 0.75 } }, ACT_POINT_ARG)).toEqual({
      x: 0.25,
      y: 0.75,
    });
    expect(boxFractionFromArgs({}, ACT_POINT_ARG)).toBeUndefined();
    expect(boxFractionFromArgs({ to: { x: 1, y: 0 } }, DRAG_TO_POINT_ARG)).toEqual({ x: 1, y: 0 });
  });

  it('clamps each fraction to the box', () => {
    expect(boxFractionFromArgs({ at: { x: -0.5, y: 3 } }, ACT_POINT_ARG)).toEqual({ x: 0, y: 1 });
  });
});

describe('pointInBox', () => {
  it('gives the point at the fractions of a box, in the box coordinates', () => {
    expect(pointInBox({ x: 100, y: 50, width: 200, height: 40 }, { x: 0.25, y: 0.75 })).toEqual({
      x: 150,
      y: 80,
    });
  });
});

describe('actPointProblem', () => {
  it('accepts a point on each pointer action, and a drag end point on a drag', () => {
    for (const action of [
      ActionType.CLICK,
      ActionType.DBLCLICK,
      ActionType.HOVER,
      ActionType.TAP,
      ActionType.DRAG,
    ]) {
      expect(actPointProblem(action, { at: { x: 0.5, y: 0.5 } })).toBeUndefined();
    }
    expect(actPointProblem(ActionType.DRAG, { to: { x: 0, y: 1 } })).toBeUndefined();
    expect(actPointProblem(ActionType.CLICK, {})).toBeUndefined();
  });

  it('refuses a point that is not two numbers, by name', () => {
    expect(actPointProblem(ActionType.CLICK, { at: { x: '1', y: 0 } })).toContain('`at`');
    expect(actPointProblem(ActionType.CLICK, { at: [0.5, 0.5] })).toContain('`at`');
    expect(actPointProblem(ActionType.DRAG, { to: { x: 0.5 } })).toContain('`to`');
    expect(actPointProblem(ActionType.CLICK, { at: { x: Number.NaN, y: 0 } })).toContain('`at`');
  });

  it('refuses a point on an action that does not land at a point', () => {
    expect(actPointProblem(ActionType.FILL, { at: { x: 0.5, y: 0.5 } })).toContain('`at`');
    expect(actPointProblem(ActionType.CLICK, { to: { x: 0.5, y: 0.5 } })).toContain('`to`');
  });
});

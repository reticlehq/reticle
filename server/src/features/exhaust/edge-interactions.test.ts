import { describe, expect, it } from 'vitest';
import {
  EdgeAction,
  EdgeInteraction,
  describeStep,
  edgeInteractions,
  looksLikeSubmit,
  RAPID_REPEAT,
} from './edge-cases.js';

const SAVE = 'button "Save"';
const NAME = 'textbox "Name"';
const fill = { key: NAME, action: 'fill' as const, value: 'x' };

const kinds = (list: { kind: string }[]): string[] => list.map((s) => s.kind);

describe('edgeInteractions', () => {
  it('builds double activation, rapid repeat, back and reload for a control', () => {
    const list = edgeInteractions({ control: 'button "Open"', order: ['button "Open"'] });
    expect(kinds(list)).toEqual([
      EdgeInteraction.DOUBLE_ACTIVATION,
      EdgeInteraction.RAPID_REPEAT,
      EdgeInteraction.ACT_THEN_BACK,
      EdgeInteraction.ACT_THEN_RELOAD,
    ]);
    const double = list.find((s) => s.kind === EdgeInteraction.DOUBLE_ACTIVATION);
    expect(double?.steps).toEqual([
      { action: EdgeAction.CLICK, key: 'button "Open"' },
      { action: EdgeAction.CLICK, key: 'button "Open"' },
    ]);
    const rapid = list.find((s) => s.kind === EdgeInteraction.RAPID_REPEAT);
    expect(rapid?.steps).toHaveLength(RAPID_REPEAT);
    expect(list.find((s) => s.kind === EdgeInteraction.ACT_THEN_RELOAD)?.steps.at(-1)).toEqual({
      action: EdgeAction.RELOAD,
    });
  });

  it('submits twice with a settle between, after the fills', () => {
    const list = edgeInteractions({ control: SAVE, order: [NAME, SAVE], fills: [fill] });
    const twice = list.find((s) => s.kind === EdgeInteraction.SUBMIT_TWICE);
    expect(twice?.steps).toEqual([
      fill,
      { action: EdgeAction.CLICK, key: SAVE },
      { action: EdgeAction.SETTLE },
      { action: EdgeAction.CLICK, key: SAVE },
    ]);
  });

  it('drives a control before the one that comes before it', () => {
    const list = edgeInteractions({ control: SAVE, order: ['link "Home"', SAVE] });
    expect(list.find((s) => s.kind === EdgeInteraction.OUT_OF_ORDER)?.steps).toEqual([
      { action: EdgeAction.CLICK, key: SAVE },
      { action: EdgeAction.CLICK, key: 'link "Home"' },
    ]);
  });

  it('submits before the fields are filled, then fills them and submits', () => {
    const list = edgeInteractions({ control: SAVE, order: [NAME, SAVE], fills: [fill] });
    const early = list.find((s) => s.kind === EdgeInteraction.SUBMIT_BEFORE_FILL);
    expect(early?.steps).toEqual([
      { action: EdgeAction.CLICK, key: SAVE },
      fill,
      { action: EdgeAction.CLICK, key: SAVE },
    ]);
  });

  it('gives a control that is not a submit no submit sequences', () => {
    const list = edgeInteractions({ control: 'tab "Billing"', order: ['tab "Billing"'] });
    expect(kinds(list)).not.toContain(EdgeInteraction.SUBMIT_TWICE);
  });

  it('is bounded and the same on every call', () => {
    const input = { control: SAVE, order: [NAME, SAVE], fills: [fill] };
    expect(edgeInteractions(input)).toEqual(edgeInteractions(input));
    expect(edgeInteractions(input, { max: 2 })).toHaveLength(2);
  });
});

describe('looksLikeSubmit', () => {
  it('knows a submit by its name', () => {
    expect(looksLikeSubmit('button "Place order"')).toBe(true);
    expect(looksLikeSubmit('button "Close"')).toBe(false);
  });
});

describe('describeStep', () => {
  it('says each step in words', () => {
    expect(describeStep({ action: EdgeAction.CLICK, key: SAVE })).toBe('click button "Save"');
    expect(describeStep({ key: NAME, action: 'fill', value: 'a' })).toBe(
      'fill textbox "Name" with "a"',
    );
    expect(describeStep({ action: EdgeAction.BACK })).toBe('back');
  });
});

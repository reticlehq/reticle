import { describe, expect, it } from 'vitest';
import { EdgeLabel, FieldKind, edgeInputs, fieldKindOf, MAX_EDGE_VALUES } from './edge-cases.js';

/** 2026-11-04T12:00:00Z — a fixed clock, so the date values are the same on every run. */
const NOW = Date.UTC(2026, 10, 4, 12);
const now = (): number => NOW;

const valuesOf = (list: { value: string }[]): string[] => list.map((e) => e.value);
const labelOf = (list: { value: string; label: string }[], value: string): string | undefined =>
  list.find((e) => e.value === value)?.label;

describe('fieldKindOf', () => {
  it('reads the type first, then the input mode, then the role, then the name', () => {
    expect(fieldKindOf({ role: 'textbox', type: 'email' })).toBe(FieldKind.EMAIL);
    expect(fieldKindOf({ role: 'textbox', inputMode: 'numeric' })).toBe(FieldKind.NUMBER);
    expect(fieldKindOf({ role: 'spinbutton' })).toBe(FieldKind.NUMBER);
    expect(fieldKindOf({ role: 'textbox', name: 'Start date' })).toBe(FieldKind.DATE);
    expect(fieldKindOf({ role: 'textbox', name: 'Title' })).toBe(FieldKind.TEXT);
  });
});

describe('edgeInputs', () => {
  it('gives every field the empty, whitespace and padded values', () => {
    const list = edgeInputs({ role: 'textbox', name: 'Title', value: 'Milk' }, { now });
    expect(labelOf(list, '')).toBe(EdgeLabel.EMPTY);
    expect(labelOf(list, '   ')).toBe(EdgeLabel.WHITESPACE);
    expect(labelOf(list, ' Milk ')).toBe(EdgeLabel.PADDED);
  });

  it('says when the empty value is in a required field', () => {
    const list = edgeInputs({ role: 'textbox', required: true }, { now });
    expect(labelOf(list, '')).toBe(EdgeLabel.EMPTY_REQUIRED);
  });

  it('types one character over maxlength, and one under minlength', () => {
    const list = edgeInputs({ role: 'textbox', maxLength: 5, minLength: 3 }, { now });
    expect(labelOf(list, 'xxxxxx')).toBe(EdgeLabel.OVER_MAX_LENGTH);
    expect(labelOf(list, 'xx')).toBe(EdgeLabel.UNDER_MIN_LENGTH);
  });

  it('gives text unicode, right-to-left and markup values', () => {
    const labels = edgeInputs({ role: 'textbox' }, { now }).map((e) => e.label);
    expect(labels).toEqual(
      expect.arrayContaining([EdgeLabel.UNICODE, EdgeLabel.RTL, EdgeLabel.MARKUP]),
    );
  });

  it('gives a number field its boundaries and a wrong format', () => {
    const list = edgeInputs({ role: 'spinbutton', min: '1', max: '10' }, { now });
    expect(labelOf(list, '0')).toBe(EdgeLabel.BELOW_MIN);
    expect(labelOf(list, '11')).toBe(EdgeLabel.ABOVE_MAX);
    expect(labelOf(list, '-1')).toBe(EdgeLabel.NEGATIVE);
    expect(labelOf(list, '999999999999999999999')).toBe(EdgeLabel.VERY_LARGE);
    expect(labelOf(list, 'abc')).toBe(EdgeLabel.WRONG_FORMAT);
  });

  it('gives a date field a past, a future and an impossible date from the injected clock', () => {
    const list = edgeInputs({ role: 'textbox', type: 'date' }, { now });
    expect(labelOf(list, '2026-11-03')).toBe(EdgeLabel.PAST_DATE);
    expect(labelOf(list, '2126-11-04')).toBe(EdgeLabel.FUTURE_DATE);
    expect(labelOf(list, '2026-02-30')).toBe(EdgeLabel.IMPOSSIBLE_DATE);
    expect(labelOf(list, '04/11/2026')).toBe(EdgeLabel.WRONG_FORMAT);
  });

  it('gives an email field a value with no @', () => {
    expect(labelOf(edgeInputs({ role: 'textbox', type: 'email' }, { now }), 'not-an-email')).toBe(
      EdgeLabel.WRONG_FORMAT,
    );
  });

  it('gives a value that breaks the pattern', () => {
    const list = edgeInputs({ role: 'textbox', pattern: '[0-9]+' }, { now });
    expect(labelOf(list, '!!!')).toBe(EdgeLabel.BREAKS_PATTERN);
  });

  it('reuses a value the app already holds as a duplicate', () => {
    const list = edgeInputs({ role: 'textbox', existing: ['Milk', 'Eggs'] }, { now });
    expect(labelOf(list, 'Milk')).toBe(EdgeLabel.DUPLICATE);
  });

  it('is bounded, has no repeated value, and is the same on every call', () => {
    const spec = {
      role: 'textbox',
      maxLength: 4,
      minLength: 2,
      pattern: '[a-z]+',
      required: true,
      value: 'ab',
      existing: ['a', 'b', 'c', 'd', 'e'],
    };
    const first = edgeInputs(spec, { now });
    expect(first.length).toBeLessThanOrEqual(MAX_EDGE_VALUES);
    expect(new Set(valuesOf(first)).size).toBe(first.length);
    expect(edgeInputs(spec, { now })).toEqual(first);
    expect(edgeInputs(spec, { now, max: 3 })).toHaveLength(3);
  });
});

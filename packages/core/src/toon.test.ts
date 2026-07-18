import { describe, it, expect } from 'vitest';
import { toToon, resultToToon, isToonable, type ToonElement } from './toon.js';

function el(over: Partial<ToonElement> = {}): ToonElement {
  return { ref: 'e1', role: 'button', name: 'Save', ...over };
}

describe('toToon', () => {
  it('emits an explicit empty marker for no elements', () => {
    expect(toToon([])).toBe('# TOON v1 — empty');
  });

  it('encodes a single element with a version header', () => {
    const out = toToon([el()]);
    expect(out.startsWith('# TOON v1\n')).toBe(true);
    expect(out).toContain('Save');
  });

  it('emits val= only for a non-empty value — "" and unset are indistinguishable', () => {
    // A known TOON limitation: a cleared textbox ("") encodes the same as one that never had a value.
    const cleared = toToon([el({ role: 'textbox', value: '' })]);
    const unset = toToon([el({ role: 'textbox' })]);
    expect(cleared).toBe(unset);
    expect(cleared).not.toContain('val=');
    expect(toToon([el({ role: 'textbox', value: 'hi' })])).toContain('val="hi"');
  });

  it('escapes quotes and backslashes in a value', () => {
    const out = toToon([el({ role: 'textbox', value: 'a"b\\c' })]);
    expect(out).toContain('val="a\\"b\\\\c"');
  });

  it('indents nested children under their parent', () => {
    const out = toToon([el({ children: [el({ ref: 'e2', name: 'Child' })] })]);
    const lines = out.split('\n');
    expect(lines[2]?.startsWith('  ')).toBe(true); // child line indented one level
  });
});

describe('resultToToon / isToonable', () => {
  it('encodes an { elements } result and rejects a non-elements result', () => {
    expect(resultToToon({ elements: [el()] })).toContain('# TOON v1');
    expect(resultToToon({ notElements: 1 })).toBe(JSON.stringify({ notElements: 1 }));
    expect(isToonable({ elements: [] })).toBe(true);
    expect(isToonable({ x: 1 })).toBe(false);
    expect(isToonable(null)).toBe(false);
    expect(isToonable([1, 2])).toBe(false);
  });
});

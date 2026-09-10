import { describe, it, expect } from 'vitest';
import { toToon, resultToToon, isToonable, type ToonElement } from './toon.js';
import { ElementState } from './constants.js';

function el(over: Partial<ToonElement> = {}): ToonElement {
  return { ref: 'e1', role: 'button', name: 'Save', ...over };
}

describe('toToon', () => {
  /**
   * `present` is on EVERY element the SDK describes — getStates seeds the array with it — so it
   * carries no information and cost eight characters per element in the layer whose whole job is
   * cutting tokens. On a 500-element snapshot that is ~4KB of nothing, on every snapshot call.
   */
  it('omits the present state, which is true of every element it could encode', () => {
    const out = toToon([
      el({
        states: [ElementState.PRESENT, ElementState.VISIBLE, ElementState.ENABLED],
        visible: true,
      }),
    ]);
    expect(out).not.toContain('present');
    expect(out).toContain('vis');
    expect(out).toContain('en');
  });

  /** An unknown state — a newer SDK than this daemon — still reaches the agent verbatim. */
  it('passes through a state it does not know', () => {
    expect(toToon([el({ states: ['teleporting'] })])).toContain('teleporting');
  });

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

  it('survives a malformed element (unvalidated wire data) without crashing the whole encode', () => {
    // resultToToon casts wire data to ToonElement; an element missing `name` used to throw
    // `name.replace is not a function` and lose the ENTIRE encode. One bad node must cost only itself.
    const result = {
      elements: [
        { ref: 'e1', role: 'button', name: 'OK' },
        { ref: 'e2', role: 'button' }, // no name
        { ref: 'e3' }, // no role or name
        { role: 'link', name: 'next' }, // no ref
      ],
    };
    const out = resultToToon(result);
    expect(out).toContain('# TOON v1');
    expect(out).toContain('"OK"'); // the good element survived
    expect(out).toContain('"next"'); // the ref-less element still encoded
    expect(out.split('\n').length).toBeGreaterThanOrEqual(4); // header + 3+ element lines, none lost
  });
});

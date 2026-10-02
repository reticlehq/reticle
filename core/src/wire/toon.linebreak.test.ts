import { describe, expect, it } from 'vitest';
import { toToon, type ToonElement } from './toon.js';

/**
 * TOON calls itself "a compact, deterministic, LINE-ORIENTED text format" and states its grammar as
 * "one element per line". The agent reads it by that rule.
 *
 * `encodeName` and `encodeValue` escaped the backslash and the double quote and nothing else, so a
 * name or value carrying a newline emitted a real line break inside a quoted string. The element
 * then spans two lines, and the second one does not match the grammar: reading `and close" [vis]`
 * as an element is the best a consumer can do with it.
 *
 * A textarea makes this ordinary rather than exotic. `val=` is the element's current value, and a
 * multi-line value is what a textarea is for.
 */
const LF = '\n';
const CR = '\r';
const TAB = '\t';
/** The two-character escape sequence, as it should appear in the encoded output. */
const ESCAPED_LF = '\\n';
const BACKSLASH = '\\';

const line = (el: Partial<ToonElement>): ToonElement => ({
  ref: 'e1',
  role: 'button',
  name: 'Save',
  states: [],
  visible: true,
  ...el,
});

/** Everything after the `# TOON v1` header. */
const body = (out: string): string[] => out.split(LF).slice(1);

describe('one element is one line, whatever the app put in the text', () => {
  it('keeps a newline in a name on one line', () => {
    expect(body(toToon([line({ name: `Save${LF}and close` })]))).toHaveLength(1);
  });

  it('keeps a newline in a value on one line', () => {
    const out = toToon([line({ role: 'textbox', value: `line one${LF}line two` })]);
    expect(body(out)).toHaveLength(1);
  });

  it('keeps a carriage return and a tab on one line', () => {
    expect(body(toToon([line({ name: `a${CR}${LF}b${TAB}c` })]))).toHaveLength(1);
  });

  it('does not let one broken element swallow the ones after it', () => {
    const out = toToon([
      line({ ref: 'e1', name: `first${LF}second` }),
      line({ ref: 'e2', name: 'After' }),
    ]);
    expect(body(out)).toHaveLength(2);
    expect(body(out)[1]).toContain('e2');
  });

  it('escapes the break rather than dropping it, so the text is still readable', () => {
    const out = toToon([line({ name: `Save${LF}and close` })]);
    expect(out).toContain(ESCAPED_LF);
    expect(out).toContain('Save');
    expect(out).toContain('and close');
  });
});

describe('it still encodes everything it encoded before', () => {
  it('keeps escaping quotes, and escapes a backslash exactly once', () => {
    const out = toToon([line({ name: `a "quoted" c:${BACKSLASH}path` })]);
    expect(out).toContain('\\"quoted\\"');
    // One literal backslash in, two out. Three would mean the escape ran twice.
    expect(out).toContain(`c:${BACKSLASH}${BACKSLASH}path`);
    expect(out).not.toContain(`c:${BACKSLASH}${BACKSLASH}${BACKSLASH}path`);
    expect(body(out)).toHaveLength(1);
  });

  it('leaves ordinary text untouched', () => {
    expect(toToon([line({ name: 'Save' })])).toContain('btn e1 "Save" [vis]');
  });
});

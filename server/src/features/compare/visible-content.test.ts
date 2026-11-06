import { describe, expect, it } from 'vitest';
import { structureLines, visibleLines } from './visible-content.js';

describe('visibleLines', () => {
  it('keeps names, values, own text and states, in page order, and drops the rest', () => {
    const tree = [
      '- main (ref=e1) [grid-cols:1fr 1fr]',
      '  - heading "Your  Cart…" (ref=e2) [src=src/App.tsx:12]',
      '  - textbox "Email" (ref=e3) [value="A@B.dev"] [focused] [component=EmailField]',
      '  - checkbox "Agree" (ref=e4) [disabled,checked] [testid=agree]',
      '  - paragraph (ref=e5) [text="Total: 3"]',
      '  - text "Pay   now"',
      '  - generic (ref=e6)',
    ].join('\n');
    expect(visibleLines(tree)).toEqual([
      'your cart',
      'email = a@b.dev',
      'agree [disabled,checked]',
      'total: 3',
      'pay now',
    ]);
  });

  it('keeps a quote inside a name, and a state with no name', () => {
    const tree = '- button "Say "hi"" (ref=e1) [pressed]\n- switch (ref=e2) [expanded]';
    expect(visibleLines(tree)).toEqual(['say "hi" [pressed]', '[expanded]']);
  });

  it('reads an empty tree as no lines', () => {
    expect(visibleLines('')).toEqual([]);
  });
});

describe('structureLines', () => {
  it('keeps the role of controls and structure, and reads a text-only role as its text', () => {
    const tree = [
      '- row "John Doe 28" (ref=e1)',
      '  - cell',
      '  - cell "John Doe" (ref=e2)',
      '  - generic (ref=e3)',
      '  - paragraph [text="Waiting"]',
      '  - button "Go" (ref=e4) [pressed]',
      '  - text "Pay   now"',
    ].join('\n');
    expect(structureLines(tree)).toEqual([
      'row john doe 28',
      'cell',
      'cell john doe',
      'waiting',
      'button go [pressed]',
      'pay now',
    ]);
  });

  it('sees a removed empty cell, a button that became text, and a removed checkbox', () => {
    const differ = (a: string, b: string): boolean =>
      structureLines(a).join('\n') !== structureLines(b).join('\n');
    expect(differ('- cell\n- cell "Ada"', '- cell "Ada"')).toBe(true);
    expect(differ('- button "Save"', '- text "Save"')).toBe(true);
    expect(differ('- checkbox (ref=e1)\n- text "Agree"', '- text "Agree"')).toBe(true);
  });

  it('reads the same text in another text-only role as the same', () => {
    expect(structureLines('- status "Waiting for you"')).toEqual(
      structureLines('- paragraph [text="Waiting for you"]'),
    );
  });
});

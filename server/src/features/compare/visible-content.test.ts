import { describe, expect, it } from 'vitest';
import { visibleLines } from './visible-content.js';

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

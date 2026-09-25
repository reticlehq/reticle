import { describe, expect, it } from 'vitest';
import { marksForAgent } from './marks-for-agent.js';

/**
 * A mark reaches the agent only while one is connected and draining. With no agent running the
 * notes sit on the page, so the HUD copies them as one prompt the person pastes into whichever agent
 * they open next: every note, the element to find, the file when the app is stamped, and the page.
 */
describe('annotations, copied as a prompt for an agent', () => {
  it('lists every note with the element, the source and the page it is on', () => {
    const text = marksForAgent(
      [
        {
          note: 'Pay does nothing',
          label: 'button: Pay',
          anchor: '[data-testid="pay"]',
          route: '/checkout',
          source: 'src/Pay.tsx:12',
        },
        { note: 'Typo in heading', label: 'heading: Welcom', anchor: 'h1', route: '/' },
      ],
      'http://localhost:5173/checkout',
    );
    expect(text).toContain('2 issues');
    expect(text).toContain('http://localhost:5173');
    expect(text).toContain('1. Pay does nothing');
    expect(text).toContain('[data-testid="pay"]');
    expect(text).toContain('src/Pay.tsx:12');
    expect(text).toContain('on /checkout');
    expect(text).toContain('2. Typo in heading');
    expect(text).toContain('verify');
  });

  it('says "issue" for one', () => {
    const text = marksForAgent(
      [{ note: 'x', label: 'button: A', anchor: 'button', route: '/' }],
      'http://localhost:3000/',
    );
    expect(text).toContain('1 issue ');
  });
});

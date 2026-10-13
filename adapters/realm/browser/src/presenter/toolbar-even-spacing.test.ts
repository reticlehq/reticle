/**
 * The bottom bar spaces its icons evenly however many are shown. It was a grid of a fixed seven
 * columns: signed out (no Harness icon) the bar showed six icons and left the seventh column empty
 * at the end, so the same bar looked evenly spaced only when signed in. Founder report, 2026-10-12.
 */
import { describe, expect, it } from 'vitest';
import { SHELL_CSS } from './presenter-shell-styles.js';

const chromeRule = (): string => {
  const rule = /\.reticle-toolbar-chrome\{([^}]*)\}/.exec(SHELL_CSS);
  if (null === rule) throw new Error('no .reticle-toolbar-chrome rule');
  return rule[1] ?? '';
};

describe('the HUD bottom bar', () => {
  it('never fixes a column count, so a missing icon leaves no gap at the end', () => {
    expect(chromeRule()).not.toMatch(/grid-template-columns\s*:\s*repeat\(\s*\d+/);
  });

  it('gives every shown icon one equal column', () => {
    expect(chromeRule()).toMatch(/grid-auto-flow\s*:\s*column/);
    expect(chromeRule()).toMatch(/grid-auto-columns\s*:\s*minmax\(0,\s*1fr\)/);
  });
});

import { describe, expect, it } from 'vitest';
import { HUD_DRAG_IGNORE_SEL } from './presenter-config.js';
import { HudShell } from './presenter-shell.js';

/**
 * The toolbar IS the drag handle, and the drag's `pointerdown` calls `preventDefault()` — which
 * suppresses the compatibility click the browser would otherwise synthesise. So a toolbar button
 * that is not in `HUD_DRAG_IGNORE_SEL` is dead to a real mouse while working under a programmatic
 * `.click()`, which is what every jsdom test uses. That is how the annotate toggle shipped inert:
 * it was added to the toolbar and never added to the list.
 *
 * Derive the buttons from the markup rather than listing them, so the next button added is covered
 * by this test on the day it is added.
 */
describe('every HUD toolbar button survives the drag handle', () => {
  it('is exempt from the drag gesture, so a real pointer press still produces a click', () => {
    const host = document.createElement('div');
    host.innerHTML = HudShell.dockHtml('', '', 'data-reticle-log', '', '');
    const buttons = [...host.querySelectorAll('.reticle-toolbar button')];
    expect(buttons.length).toBeGreaterThan(0);

    const dead = buttons
      .filter((btn) => null === btn.closest(HUD_DRAG_IGNORE_SEL))
      .map((btn) => btn.getAttribute('aria-label') ?? btn.outerHTML.slice(0, 60));

    expect(dead).toEqual([]);
  });
});

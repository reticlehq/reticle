/**
 * A toolbar tooltip must render IN FRONT of the panels it overlaps.
 *
 * Reported: hovering a HUD menu item shows its tooltip behind the chat panel or the settings panel.
 * It is a stacking bug and the numbers are the whole story — every one of these is a sibling in the
 * HUD's own stacking context:
 *
 *     .reticle-tb-tip        z-index: 3    <- the tooltip
 *     [data-reticle-chat-panel]  z-index: 8
 *     [data-reticle-settings-panel] z-index: 30
 *
 * A tooltip is the one element that is always transient and always meant to be read, so it belongs
 * above everything the HUD draws. It was below both.
 *
 * Asserted on the generated CSS rather than in a browser because that is where the defect lives: no
 * layout is required to see that 3 < 8. The relationship is the invariant, so the test compares the
 * values against each other rather than pinning a magic number that a later panel could quietly
 * exceed again.
 */

import { describe, expect, it } from 'vitest';
import { Z_HUD_TOOLTIP } from './presenter-config.js';
import { SHELL_CSS } from './presenter-shell-styles.js';
import { CONTROLS_CSS } from './presenter-controls.js';
import { SETTINGS_CSS } from './presenter-settings-styles.js';

/** Every `z-index: N` in a stylesheet, as numbers. */
function zIndexes(css: string): number[] {
  return [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
}

describe('the toolbar tooltip stacks above every HUD panel', () => {
  it('is declared above the chat panel', () => {
    const highestPanel = Math.max(...zIndexes(CONTROLS_CSS));
    expect(Z_HUD_TOOLTIP).toBeGreaterThan(highestPanel);
  });

  it('is declared above the settings panel', () => {
    const highestPanel = Math.max(...zIndexes(SETTINGS_CSS));
    expect(Z_HUD_TOOLTIP).toBeGreaterThan(highestPanel);
  });

  it('actually uses that value in the tooltip rule', () => {
    // The constant existing is not the fix; the rule using it is.
    const rule = SHELL_CSS.match(/\.reticle-tb-tip\{[^}]*\}/)?.[0] ?? '';
    expect(rule, 'the tooltip rule must be present at all').not.toBe('');
    expect(rule).toContain(`z-index:${String(Z_HUD_TOOLTIP)}`);
  });

  it('stays inside the HUD’s own layer rather than escaping to the top of the page', () => {
    // Above the HUD's panels, NOT above the whole document. The HUD sits in one stacking context on
    // purpose; a tooltip that outranks the page would paint over the app the user is verifying.
    expect(Z_HUD_TOOLTIP).toBeLessThan(2_147_483_600);
  });

  it('lifts the HUD block itself, because the block is a stacking context', () => {
    // Driven on 2026-09-26: every toolbar tooltip still drew behind the chat panel with all of the
    // numbers above in order. The HUD block is transformed, which makes it a stacking context at
    // level 0 inside the dock, so the tooltip's z-index only ranked it inside the block, and the
    // chat panel beside the block won. Comparing numbers cannot see a context boundary; the rule
    // that raises the block while a tooltip can show is what fixes it.
    const lift = SHELL_CSS.match(/\[data-reticle-hud\]:hover[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(lift).toContain(`z-index:${String(Z_HUD_TOOLTIP)}`);
  });
});

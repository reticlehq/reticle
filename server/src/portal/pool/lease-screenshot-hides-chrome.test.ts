/**
 * A lease screenshot hides Reticle's own UI, the same set the driven path hides (#1355).
 *
 * `screenshotLease` took `page.screenshot({ fullPage })` with nothing hiding the overlay, so a lease
 * baseline captured the HUD, its activity log and the toolbar, and `reticle_visual_diff` read a HUD
 * change as an app regression. The driven path's `capturePage` hid `[data-reticle-overlay]` only.
 * Both now take the same options, built from core's selector list. This pins the plumbing; the pixel
 * half needs a real browser and lives outside the unit gate.
 */
import { describe, expect, it } from 'vitest';
import { HIDE_RETICLE_CHROME_CSS, RETICLE_OVERLAY_SELECTOR } from '@reticlehq/core';
import { leaseScreenshotOptions, SCREENSHOT_DETERMINISM } from './playwright-launcher.js';

describe('the options a lease screenshot is taken with', () => {
  it('hide every piece of Reticle chrome, not only the overlay root', () => {
    const { style } = leaseScreenshotOptions();
    for (const selector of RETICLE_OVERLAY_SELECTOR.split(',')) {
      expect(style, selector).toContain(selector);
    }
    expect(style).toContain('display:none !important');
  });

  it('settle animations, as the driven path does', () => {
    expect(leaseScreenshotOptions().animations).toBe('disabled');
  });

  it('are the driven path options plus fullPage, so the two paths cannot drift', () => {
    expect(leaseScreenshotOptions({ fullPage: true })).toEqual({
      ...SCREENSHOT_DETERMINISM,
      fullPage: true,
    });
    expect(leaseScreenshotOptions().fullPage).toBe(false);
    expect(SCREENSHOT_DETERMINISM.style).toBe(HIDE_RETICLE_CHROME_CSS);
  });
});

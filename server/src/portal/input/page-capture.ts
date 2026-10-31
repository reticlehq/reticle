/**
 * A screenshot of a Playwright page, shared by the CDP and launched providers so the capture path
 * lives in one place.
 */
import type { Page } from 'playwright';
import type { ElementBox } from './real-input.js';
import {
  SCREENSHOT_DETERMINISM,
  captureWithChromeHidden,
} from '@/portal/pool/playwright-launcher.js';

/** Options for a page screenshot — full-page scroll capture and/or a clip box. */
export interface ScreenshotOpts {
  fullPage?: boolean;
  /** Restrict the capture to one element/region (viewport CSS px). */
  clip?: ElementBox;
  /**
   * A live picture, as a JPEG at this quality: what a person is watching, taken as it is. The
   * baseline tweaks (hiding the HUD, stopping animations) would make their window flicker each second.
   */
  jpegQuality?: number;
  /** One image pixel per CSS pixel, so a high-density display does not double a step screenshot. */
  cssScale?: boolean;
}

/**
 * Capture a PNG from a Playwright page. Shared by the CDP + launched providers so the
 * screenshot path lives in one place (mirrors performGesture). Returns the raw PNG bytes.
 */
export async function capturePage(page: Page, opts: ScreenshotOpts): Promise<Uint8Array> {
  // A step capture injects nothing into the page, so Reticle's own hosts are hidden another way.
  if (true === opts.cssScale) {
    return captureWithChromeHidden({ evaluate: (script: string) => page.evaluate(script) }, () =>
      shoot(page, opts),
    );
  }
  return shoot(page, opts);
}

/** Playwright screenshot options for one capture: a JPEG, a clip, the full page, or the viewport. */
function screenshotOptions(opts: ScreenshotOpts): Parameters<Page['screenshot']>[0] {
  if (opts.jpegQuality !== undefined) {
    return {
      type: 'jpeg',
      quality: opts.jpegQuality,
      ...(true === opts.cssScale ? { scale: 'css' as const } : {}),
    };
  }
  if (opts.clip !== undefined) {
    return { ...SCREENSHOT_DETERMINISM, clip: opts.clip };
  }
  if (true === opts.fullPage) {
    return { ...SCREENSHOT_DETERMINISM, fullPage: true };
  }
  return { ...SCREENSHOT_DETERMINISM };
}

async function shoot(page: Page, opts: ScreenshotOpts): Promise<Uint8Array> {
  const buf = await page.screenshot(screenshotOptions(opts));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

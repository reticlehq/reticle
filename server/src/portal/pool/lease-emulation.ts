/**
 * What a lease can emulate: the two media features a person sets in their OS, and the width.
 *
 * Without them, prefers-reduced-motion and prefers-color-scheme could not be set on a leased tab,
 * so the CSS half of reduced motion and the dark theme could not be checked live. A lease is a
 * Playwright context, which takes all three before the first paint and the media again per call.
 */

export const ColorScheme = {
  LIGHT: 'light',
  DARK: 'dark',
  NO_PREFERENCE: 'no-preference',
} as const;
export type ColorScheme = (typeof ColorScheme)[keyof typeof ColorScheme];
export const ReducedMotion = { REDUCE: 'reduce', NO_PREFERENCE: 'no-preference' } as const;
export type ReducedMotion = (typeof ReducedMotion)[keyof typeof ReducedMotion];

/** The media features a page reads with matchMedia. */
export interface LeaseMedia {
  colorScheme?: ColorScheme;
  reducedMotion?: ReducedMotion;
}

/** What a lease opens with: the media, and a viewport. */
export interface LeaseEmulation extends LeaseMedia {
  viewport?: { width: number; height: number };
}

/** The page's own layout viewport, read back after a resize. */
const VIEWPORT_READ_SCRIPT = '[window.innerWidth, window.innerHeight]';

/** The size a page reports for itself, or undefined when it cannot be read. */
export async function readViewport(page: {
  evaluate?(script: string): Promise<unknown>;
}): Promise<{ width: number; height: number } | undefined> {
  if (page.evaluate === undefined) {
    return undefined;
  }
  try {
    const size = await page.evaluate(VIEWPORT_READ_SCRIPT);
    const [width, height] = Array.isArray(size) ? (size as unknown[]) : [];
    return 'number' === typeof width && 'number' === typeof height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

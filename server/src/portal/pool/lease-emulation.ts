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

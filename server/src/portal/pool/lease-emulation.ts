/**
 * What a lease can emulate: the two media features a person sets in their OS, and the width.
 *
 * Without them, prefers-reduced-motion and prefers-color-scheme could not be set on a leased tab,
 * so the CSS half of reduced motion and the dark theme could not be checked live. A lease is a
 * Playwright context, which takes all three before the first paint and the media again per call.
 */

import type { DeterminismOptions } from './determinism.js';

export const ColorScheme = {
  LIGHT: 'light',
  DARK: 'dark',
  NO_PREFERENCE: 'no-preference',
} as const;
export type ColorScheme = (typeof ColorScheme)[keyof typeof ColorScheme];
export const ReducedMotion = { REDUCE: 'reduce', NO_PREFERENCE: 'no-preference' } as const;
export type ReducedMotion = (typeof ReducedMotion)[keyof typeof ReducedMotion];
export const Pointer = { FINE: 'fine', COARSE: 'coarse' } as const;
export type Pointer = (typeof Pointer)[keyof typeof Pointer];

/** The media features a page reads with matchMedia. */
export interface LeaseMedia {
  colorScheme?: ColorScheme;
  reducedMotion?: ReducedMotion;
}

/** What a lease opens with: the media, a viewport, and the pointer the page reads. */
export interface LeaseEmulation extends LeaseMedia {
  viewport?: { width: number; height: number };
  /**
   * The primary pointer `@media (pointer: ...)` reports. Unlike the media features, it is fixed
   * when the context opens: Playwright's touch support is a context option, so a live lease cannot
   * be given one. Without it a touch-only rule could not be reached at all, and a lease answered
   * every `(pointer: coarse)` query with a mouse (#1903).
   */
  pointer?: Pointer;
  /** A seeded random source and a stepped clock, installed before any page script (determinism.ts). */
  deterministic?: DeterminismOptions;
}

/** The same emulation in the names Playwright's own context options use. */
export interface ContextEmulation extends LeaseMedia {
  viewport?: { width: number; height: number };
  hasTouch?: boolean;
  deviceScaleFactor?: number;
}

/**
 * Translate a lease's emulation into context options. `pointer` is not one of Playwright's: a
 * coarse primary pointer is what touch support produces, so it travels as `hasTouch`.
 *
 * Measured in real headless Chromium: `hasTouch: true` makes `(pointer: coarse)` match and
 * `(pointer: fine)` stop matching, with `maxTouchPoints` at 1. `isMobile` does the same and also
 * changes viewport-meta handling, so it is deliberately left out.
 */
export function contextEmulationOf(emulate: LeaseEmulation): ContextEmulation {
  const { pointer, deterministic, ...rest } = emulate;
  return {
    ...rest,
    ...(pointer === undefined ? {} : { hasTouch: Pointer.COARSE === pointer }),
    // A deterministic page draws at one density on every machine.
    ...(deterministic === undefined ? {} : { deviceScaleFactor: 1 }),
  };
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

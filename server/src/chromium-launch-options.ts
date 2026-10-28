/**
 * The launch options every Reticle-driven Chromium gets, in one place.
 *
 * A pooled browser serves several lease contexts while only one page is ever the visible one, and a
 * driven page can sit in a window the host does not treat as visible. For everyone else Chromium
 * throttles timers, suspends rAF, and deprioritizes the renderer, which is exactly the state a
 * session reports as `throttled: true`: WebSocket- and timer-driven DOM updates land seconds late,
 * asserts time out on content that appears right after the timeout, with no refetch, because the
 * app was fine and the browser was parked. The three switches below are the documented opt-outs,
 * shared by both launch sites so the pooled path (`playwright-launcher`) and the drive path
 * (`real-input`) cannot drift apart.
 */

/**
 * Chromium switches that keep background pages running at full speed. Named individually rather
 * than as one free string per call site, so a typo is a test failure instead of a silently ignored
 * argument.
 */
export const CHROMIUM_ANTI_THROTTLING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

/**
 * The Chromium switch that opens a headed window at the size of the screen. With `viewport: null`
 * the page then takes that window's size and the screen's real pixel ratio.
 */
export const HEADED_WINDOW_ARGS = ['--start-maximized'] as const;

/** The page size of a headless page, which has no window and no screen to take a size from. */
export const HEADLESS_VIEWPORT = { width: 1440, height: 900 } as const;

/** A page size in CSS pixels. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** The viewport option for a context or a page; null is the window's real size. */
export interface PageViewportOptions {
  viewport: ViewportSize | null;
}

/**
 * The viewport option for every page Reticle opens, at every launch site. Without it, Playwright
 * gives each page a fixed 1280x720 at pixel ratio 1, whatever the window is. A size that a lease
 * asks for always wins; only the default changes.
 */
export function pageViewportOptions(
  headless: boolean,
  requested?: ViewportSize,
): PageViewportOptions {
  if (requested !== undefined) {
    return { viewport: requested };
  }
  return { viewport: headless ? { ...HEADLESS_VIEWPORT } : null };
}

/** The options object handed to `chromium.launch` at both launch sites. */
export interface ChromiumLaunchOptions {
  headless: boolean;
  args: string[];
  /** An installed Chrome/Edge to drive instead of Playwright's own build; absent = the bundled one. */
  channel?: string;
  /** A Chromium executable to launch directly, from RETICLE_CHROMIUM_PATH. */
  executablePath?: string;
}

/**
 * Build the launch options for a headless or headed Chromium. Pure; returns a fresh mutable array
 * each call so no caller can mutate the constant behind everyone else's back.
 */
export function chromiumLaunchOptions(
  headless: boolean,
  channel?: string,
  executablePath?: string,
): ChromiumLaunchOptions {
  return {
    headless,
    args: headless
      ? [...CHROMIUM_ANTI_THROTTLING_ARGS]
      : [...CHROMIUM_ANTI_THROTTLING_ARGS, ...HEADED_WINDOW_ARGS],
    ...(channel === undefined ? {} : { channel }),
    ...(executablePath === undefined ? {} : { executablePath }),
  };
}

/**
 * The browser a page runs in, by brand.
 *
 * No zod here: the SDK reads these on the way in, and a module that builds classic zod schemas
 * brings about 85 KB onto every page (#2369).
 */

/**
 * The browser BRAND behind the connected page — the axis `engine` cannot answer.
 *
 * Chrome, Edge, Arc, Dia, Brave and Opera are all `blink`, and the most common mode by far is
 * `attached`: Reticle launched nothing, so the page itself is the only thing that knows which
 * browser it is. A CLOSED list on purpose — the raw UA string and a raw `userAgentData` brand are
 * both unbounded and fingerprintable, so anything unrecognised reports `OTHER` rather than
 * forwarding an unrecognised name.
 */
export const BrowserBrand = {
  CHROME: 'chrome',
  EDGE: 'edge',
  ARC: 'arc',
  DIA: 'dia',
  BRAVE: 'brave',
  OPERA: 'opera',
  FIREFOX: 'firefox',
  SAFARI: 'safari',
  /** Anything we do not recognise — including a Chromium that names no brand at all. */
  OTHER: 'other',
} as const;
export type BrowserBrand = (typeof BrowserBrand)[keyof typeof BrowserBrand];

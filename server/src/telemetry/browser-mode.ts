/**
 * Was this verification watched by a person, or run by a machine?
 *
 * A verification's cost and its meaning both depend on it. A headless run is CI or an unattended
 * agent loop — it should be fast, and there is nobody to notice a wrong answer. A headed run has a
 * human in front of it. And the most common case of all is neither: the SDK in somebody's own dev
 * server, in their own browser, which Reticle never launched at all.
 *
 * Recorded once at daemon start, because that is when the decision is made and it does not change
 * for the daemon's life. Defaults to ATTACHED, which is the honest answer when Reticle launched
 * nothing: claiming "headless" for a browser we did not open would be a guess about somebody's
 * machine.
 */

export const BrowserMode = {
  /** Reticle launched the browser with no display — CI, or an unattended agent loop. */
  HEADLESS: 'headless',
  /** Reticle launched a visible browser — a human is watching. */
  HEADED: 'headed',
  /** Reticle launched nothing: the SDK connected from a browser somebody else opened. */
  ATTACHED: 'attached',
} as const;
export type BrowserMode = (typeof BrowserMode)[keyof typeof BrowserMode];

let current: BrowserMode = BrowserMode.ATTACHED;

/** Record how this daemon drives a browser. Called once, at start. */
export function setBrowserMode(mode: BrowserMode): void {
  current = mode;
}

export function getBrowserMode(): BrowserMode {
  return current;
}

/** Tests only — restore the default so cases do not leak into each other. */
export function resetBrowserMode(): void {
  current = BrowserMode.ATTACHED;
}

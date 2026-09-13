/** Shared fixtures for the presenter test suites (presenter.test.ts + presenter-lifecycle.test.ts). */

export const FAST_IDLE_MS = 20;
export const FAST_FADE_MS = 5;
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until true or timeout - robust to real-timer lateness under load (no flake). */
/**
 * Wait for something to become true, and say whether it did.
 *
 * The default deadline is deliberately far longer than any of these transitions takes. What is being
 * checked is that the panel SETTLES, which is a fact about the code; how long it takes to get there
 * is a fact about the machine. A deadline tight enough to trip under load trips in CI and nowhere
 * else, and a check that only fails on a busy runner teaches people to press re-run instead of to
 * look. A real failure still ends quickly, because the test's own timeout bounds it.
 */
export const until = async (pred: () => boolean, ms = 10_000): Promise<boolean> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await wait(5);
  }
  return true;
};

export const dataOn = (): string | null =>
  document.querySelector('[data-reticle-glow]')?.getAttribute('data-on') ?? null;
export const dataBusy = (): string | null =>
  document.querySelector('[data-reticle-glow]')?.getAttribute('data-busy') ?? null;

interface GlowFlips {
  enters: number;
  exits: number;
  stop: () => void;
}

export function trackGlowFlips(glow: HTMLElement): GlowFlips {
  const counts = { enters: 0, exits: 0 };
  const obs = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.attributeName !== 'data-on') continue;
      const v = glow.getAttribute('data-on');
      if ('1' === v) counts.enters++;
      if ('0' === v) counts.exits++;
    }
  });
  obs.observe(glow, { attributes: true, attributeFilter: ['data-on'] });
  return {
    get enters() {
      return counts.enters;
    },
    get exits() {
      return counts.exits;
    },
    stop: () => obs.disconnect(),
  };
}

/** Shared fixtures for the presenter test suites (presenter.test.ts + presenter-lifecycle.test.ts). */

export const FAST_IDLE_MS = 20;
export const FAST_FADE_MS = 5;
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until true or timeout — robust to real-timer lateness under load (no flake). */
export const until = async (pred: () => boolean, ms = 1000): Promise<boolean> => {
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

export interface GlowFlips {
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
      if (v === '1') counts.enters++;
      if (v === '0') counts.exits++;
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

import { describe, it, expect } from 'vitest';
import { Presenter } from './presenter.js';
import { buildSnapshot } from './snapshot.js';
import { isIgnored } from './dom-ignore.js';

const FAST_IDLE_MS = 20;
const FAST_FADE_MS = 5;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface GlowFlips {
  enters: number;
  exits: number;
  stop: () => void;
}

function trackGlowFlips(glow: HTMLElement): GlowFlips {
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

describe('presenter / transparency layer', () => {
  it('mounts an overlay that is excluded from snapshots, then narrates + destroys', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    const hud = document.querySelector('[data-iris-hud]');
    expect(hud).not.toBeNull();
    expect(isIgnored(hud as Element)).toBe(true);

    // The HUD's "idle"/"Save" text must NOT leak into the page snapshot.
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('idle');

    p.narrate('Clicking Save to verify the flow');
    expect(document.querySelector('[data-iris-hud] .iris-note')?.textContent).toContain(
      'Clicking Save',
    );

    p.destroy();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });
});

describe('presenter glow state machine', () => {
  it('coalesces a burst into exactly one busy-enter and one idle-exit (no flicker)', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      paceMs: 0,
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    // 10 rapid activities, each 10ms apart (< idle window): only the first should flip on.
    for (let i = 0; i < 10; i++) {
      t += 1;
      p.status(`step ${String(i)}`);
    }
    expect(p.glowPhase()).toBe('busy');

    // Go quiet: jump clock past the idle window, let native timers fire the fade-out.
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();

    expect(flips.enters).toBe(1);
    expect(flips.exits).toBe(1);
    expect(p.glowPhase()).toBe('idle');
    flips.stop();
    p.destroy();
  });

  it('a single activity from idle enters busy then auto-idles', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      paceMs: 0,
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    p.status('one');
    expect(p.glowPhase()).toBe('busy');

    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();

    expect(p.glowPhase()).toBe('idle');
    expect(flips.enters).toBe(1);
    expect(flips.exits).toBe(1);
    flips.stop();
    p.destroy();
  });

  it('activity during the fade window resumes busy with a fresh enter', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      paceMs: 0,
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: 1000, // long fade so we can catch the FADING phase
    });
    p.mount();
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    p.status('one');
    t += 1000;
    await wait(FAST_IDLE_MS + 10); // idle check fires -> begins fade
    expect(p.glowPhase()).toBe('fading');

    p.status('resumed'); // activity during fade
    expect(p.glowPhase()).toBe('busy');
    await flush();
    expect(flips.enters).toBe(2);
    flips.stop();
    p.destroy();
  });

  it('does not write data-on on steady busy (no per-action restart)', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      paceMs: 0,
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    p.status('first');
    for (let i = 0; i < 5; i++) {
      t += 1;
      p.status(`more ${String(i)}`);
    }
    await flush();
    expect(flips.enters).toBe(1);
    flips.stop();
    p.destroy();
  });
});

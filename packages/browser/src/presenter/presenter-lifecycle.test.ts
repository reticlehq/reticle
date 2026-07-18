import { describe, it, expect } from 'vitest';
import { PresenterMode } from '@reticlehq/core';
import { Presenter } from './presenter.js';
import {
  FAST_IDLE_MS,
  FAST_FADE_MS,
  flush,
  wait,
  until,
  trackGlowFlips,
  dataOn,
  dataBusy,
} from './presenter-test-helpers.js';

describe('presenter v2 session border', () => {
  it('1 sessionStart turns the base border on (data-on=1)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    p.sessionStart();
    expect(dataOn()).toBe('1');
    p.destroy();
  });

  it('2 border STAYS on across 10 commands — never data-on=0 mid-session', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'session',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    p.sessionStart(); // single data-on=1 write, observed as one enter
    for (let i = 0; i < 10; i++) {
      t += 1;
      p.status(`step ${String(i)}`);
    }
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(flips.exits).toBe(0);
    expect(dataOn()).toBe('1');
    expect(flips.enters).toBe(1);
    flips.stop();
    p.destroy();
  });

  it('3 markActivity modulates data-busy, not data-on', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'session',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    p.sessionStart();
    p.status('one');
    expect(dataBusy()).toBe('1');
    expect(dataOn()).toBe('1');
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(dataBusy()).toBe('0');
    expect(dataOn()).toBe('1');
    p.destroy();
  });

  it('3b activity log/HUD persists the whole session — never fades on idle', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'session',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const hud = document.querySelector('[data-reticle-hud]') as HTMLElement;
    p.sessionStart();
    expect(hud.getAttribute('data-on')).toBe('1'); // shown from session start
    p.status('one');
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(hud.getAttribute('data-on')).toBe('1'); // STILL on after going idle (the fix)
    p.sessionEnd();
    expect(hud.getAttribute('data-on')).toBe('0'); // hidden only on session end
    p.destroy();
  });

  it('3c minimise button collapses to a bar; clicking the bar restores it', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    const overlay = document.querySelector('div[data-reticle-overlay]') as HTMLElement;
    const head = document.querySelector('.reticle-hud-head') as HTMLElement;
    (document.querySelector('[data-reticle-min-btn]') as HTMLElement).click();
    expect(overlay.getAttribute('data-reticle-min')).toBe('1'); // collapsed to the bar
    head.click(); // clicking the minimised bar restores the panel
    expect(overlay.getAttribute('data-reticle-min')).toBe('0');
    p.destroy();
  });

  it('3d the minimised bar shows the latest activity in the live line', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    p.log('act', 'Clicking Pay');
    p.log('narration', 'now checking the receipt');
    expect(document.querySelector('.reticle-live')?.textContent).toBe('now checking the receipt');
    p.destroy();
  });

  it('4 sessionEnd clears the base border (data-on=0)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    p.sessionStart();
    p.sessionEnd();
    expect(dataOn()).toBe('0');
    p.destroy();
  });

  it('5 sessionStart twice is idempotent', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    p.sessionStart();
    p.sessionStart();
    await flush();
    expect(flips.enters).toBe(1);
    expect(dataOn()).toBe('1');
    flips.stop();
    p.destroy();
  });

  it('6 sessionEnd without sessionStart is a no-op (no throw)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    expect(() => p.sessionEnd()).not.toThrow();
    expect(flips.exits).toBe(0);
    flips.stop();
    p.destroy();
  });

  it('7 sessionEnd is idempotent', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    p.sessionStart();
    p.sessionEnd();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    expect(() => p.sessionEnd()).not.toThrow();
    expect(flips.exits).toBe(0);
    flips.stop();
    p.destroy();
  });

  it('8 busy shimmer settles to idle but border persists', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'session',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    p.sessionStart();
    p.status('x');
    t += 1000;
    // Poll instead of a fixed wait: the busy→fading→idle chain runs on real timers, which fire late
    // under load — a fixed sleep flaked ("fading" instead of "idle"). The clock (now) is fixed, so
    // the logic is deterministic; only the timer scheduling is slow.
    expect(await until(() => p.glowPhase() === 'idle')).toBe(true);
    expect(dataBusy()).toBe('0');
    expect(dataOn()).toBe('1');
    p.destroy();
  });

  it('9 shimmer hue follows mode without toggling base border', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    p.sessionStart();
    p.setMode(PresenterMode.READING);
    expect(document.querySelector('[data-reticle-mode]')?.getAttribute('data-reticle-mode')).toBe(
      'reading',
    );
    expect(dataOn()).toBe('1');
    p.destroy();
  });
});

describe("presenter v2 border:'busy' back-compat", () => {
  it('10 reproduces fade-out', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    p.status('one');
    expect(dataOn()).toBe('1');
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(flips.enters).toBe(1);
    expect(flips.exits).toBe(1);
    expect(p.glowPhase()).toBe('idle');
    expect(dataOn()).toBe('0');
    flips.stop();
    p.destroy();
  });

  it('11 sessionStart is a no-op on the base border', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'busy' });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);
    p.sessionStart();
    expect(flips.enters).toBe(0);
    expect(dataOn()).not.toBe('1'); // busy mode: sessionStart never forces the base border on
    flips.stop();
    p.destroy();
  });

  it('12 sessionEnd is a no-op on the base border', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'busy' });
    p.mount();
    p.status('x');
    expect(dataOn()).toBe('1');
    expect(() => p.sessionEnd()).not.toThrow();
    expect(dataOn()).toBe('1');
    p.destroy();
  });

  it('13 default border mode is session', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({ now: () => t, idleAfterMs: FAST_IDLE_MS, glowFadeMs: FAST_FADE_MS });
    p.mount();
    p.sessionStart();
    p.status('x');
    t += 1000;
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(dataOn()).toBe('1');
    p.destroy();
  });
});

describe('presenter v2 not-mounted safety', () => {
  it('14 sessionStart before mount is a safe no-op', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    expect(() => p.sessionStart()).not.toThrow();
    expect(document.querySelector('[data-reticle-glow]')).toBeNull();
  });

  it('15 sessionEnd before mount is a safe no-op', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    expect(() => p.sessionEnd()).not.toThrow();
  });

  it('16 markActivity before mount is a safe no-op', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    expect(() => p.status('x')).not.toThrow();
  });
});

describe('presenter v2 HUD positioning', () => {
  it('HUD is docked bottom-center with a fixed size (never resizes with content)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    const css = document.querySelector('style[data-reticle-overlay]')?.textContent ?? '';
    // bottom-center dock (like a chatbox), horizontally centered
    expect(css).toContain('left:50%;right:auto;bottom:20px');
    expect(css).toContain('translateX(-50%)');
    // fixed width + height so the panel doesn't jump with children's text width
    expect(css).toContain('width:384px;height:468px');
    // the feed flexes/scrolls inside the fixed card
    expect(css).toContain('[data-reticle-log]{flex:1;min-height:0;overflow-y:auto');

    p.destroy();
  });
});

describe('presenter glow state machine', () => {
  it('coalesces a burst into exactly one busy-enter and one idle-exit (no flicker)', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      paceMs: 0,
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    // 10 rapid activities, each 10ms apart (< idle window): only the first should flip on.
    for (let i = 0; i < 10; i++) {
      t += 1;
      p.status(`step ${String(i)}`);
    }
    expect(p.glowPhase()).toBe('busy');

    // Go quiet: jump clock past the idle window, let native timers fire the fade-out.
    t += 1000;
    expect(await until(() => p.glowPhase() === 'idle')).toBe(true);
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
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    p.status('one');
    expect(p.glowPhase()).toBe('busy');

    t += 1000;
    expect(await until(() => p.glowPhase() === 'idle')).toBe(true);
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
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: 1000, // long fade so we can catch the FADING phase
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
    const flips = trackGlowFlips(glow);

    p.status('one');
    t += 1000;
    expect(await until(() => p.glowPhase() === 'fading')).toBe(true);
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
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-reticle-glow]') as HTMLElement;
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

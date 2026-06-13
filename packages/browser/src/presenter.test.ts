import { describe, it, expect } from 'vitest';
import { PresenterMode } from '@iris/protocol';
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

describe('presenter H2 reading vs acting', () => {
  it('READING sets mode + chip and hides the cursor', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    p.setMode(PresenterMode.READING);
    expect(p.mode).toBe(PresenterMode.READING);
    const chip = document.querySelector('[data-iris-chip]');
    expect(chip?.textContent).toBe('READING');
    expect(chip?.getAttribute('data-mode')).toBe('reading');
    expect(document.querySelector('[data-iris-cursor]')?.getAttribute('data-on')).toBe('0');

    p.destroy();
  });

  it('ACTING sets mode + chip', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    p.setMode(PresenterMode.ACTING);
    expect(p.mode).toBe(PresenterMode.ACTING);
    expect(document.querySelector('[data-iris-chip]')?.textContent).toBe('ACTING');

    p.destroy();
  });

  it('chip text never leaks into snapshots', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    p.setMode(PresenterMode.READING);
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).not.toContain('READING');

    p.destroy();
  });
});

describe('presenter narration queue / min-dwell', () => {
  // native-timers binds the real setTimeout at module load, so vitest fake timers can't drive
  // the dwell. Use a small REAL dwell + wait(), matching the glow-state-machine tests' approach.
  const DWELL = 40;
  const note = (): string | null =>
    document.querySelector('[data-iris-hud] .iris-note')?.textContent ?? null;

  it('enqueues three rapid narrations FIFO; each is visible for >= min-dwell', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0, narrationDwellMs: DWELL });
    p.mount();

    p.narrate('line one');
    p.narrate('line two');
    p.narrate('line three');

    // First shows immediately; the other two are queued, not clobbered.
    expect(note()).toBe('line one');

    await wait(DWELL * 0.5);
    expect(note()).toBe('line one'); // still visible before its min-dwell elapses

    await wait(DWELL); // past the first dwell
    expect(note()).toBe('line two');

    await wait(DWELL);
    expect(note()).toBe('line three');

    await wait(DWELL * 2);
    expect(note()).toBe('line three'); // last line stays; queue drained

    p.destroy();
  });

  it('keeps the action status chip separate from the narration line', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0, narrationDwellMs: DWELL });
    p.mount();

    p.status('READING the page');
    p.narrate('intent');
    expect(document.querySelector('[data-iris-hud] .iris-act')?.textContent).toBe(
      'READING the page',
    );
    expect(note()).toBe('intent');

    await wait(DWELL * 1.5); // advancing the queue must not touch the act line
    expect(document.querySelector('[data-iris-hud] .iris-act')?.textContent).toBe(
      'READING the page',
    );

    p.destroy();
  });

  it('destroy mid-dwell clears the timer and removes the overlay', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0, narrationDwellMs: DWELL });
    p.mount();

    p.narrate('first');
    p.narrate('second');
    p.destroy();

    await wait(DWELL * 2); // a leaked timer firing into a removed node would throw here
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });

  it('queued narration never leaks into snapshots', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({ paceMs: 0, narrationDwellMs: DWELL });
    p.mount();

    p.narrate('one');
    p.narrate('two');
    p.narrate('three');

    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('one');
    expect(snap.tree).not.toContain('two');

    p.destroy();
  });

  it('caps the pending queue without dropping the visible line', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0, narrationDwellMs: DWELL });
    p.mount();

    for (let i = 0; i < 60; i++) p.narrate(`line ${String(i)}`);
    // line 0 shows immediately; the cap drops oldest *pending* lines, never the visible one.
    expect(note()).toBe('line 0');

    await wait(DWELL); // advance once: the next surfaced line must be a still-pending one
    expect(note()).not.toBe('line 0');

    p.destroy();
  });

  it('HUD is positioned bottom-center (left:50% + translateX(-50%), both states)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    const css = document.querySelector('style[data-iris-overlay]')?.textContent ?? '';
    expect(css).toContain('left:50%');
    expect(css).toContain('translateX(-50%)');
    // regression guard: the data-on toggle must keep the horizontal centering
    expect(css).toContain('[data-iris-hud][data-on="1"]{opacity:1;transform:translateX(-50%)');

    p.destroy();
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

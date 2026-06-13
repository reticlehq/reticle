import { describe, it, expect } from 'vitest';
import { PresenterMode } from '@syrin/iris-protocol';
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
    expect(document.querySelector('[data-iris-log] .iris-log-text')?.textContent).toContain(
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

const LOG_ROW_SEL = '[data-iris-log] [data-iris-log-row]';
const logRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(LOG_ROW_SEL));
const rowTexts = (): (string | null)[] =>
  logRows().map((r) => r.querySelector('.iris-log-text')?.textContent ?? null);

describe('presenter v2 activity log', () => {
  it('L1 log() appends a row with mode chip, text, timestamp', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ now: () => 1000 });
    p.mount();
    p.log('read', 'Looking at the page');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector('.iris-log-text')?.textContent).toBe('Looking at the page');
    expect(rows[0]?.querySelector('.iris-chip')?.textContent).toBe('READ');
    expect(
      (rows[0]?.querySelector('[data-iris-log-ts]')?.textContent ?? '').length,
    ).toBeGreaterThan(0);
    p.destroy();
  });

  it('L2 three rapid narrations persist as three ordered rows (NONE overwritten)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('narration', 'one');
    p.log('narration', 'two');
    p.log('narration', 'three');
    expect(logRows().length).toBe(3);
    expect(rowTexts()).toEqual(['one', 'two', 'three']);
    p.destroy();
  });

  it('L3 mixed read+act+narration ordering preserved', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'snap');
    p.log('act', 'click Save');
    p.log('narration', 'adding a beat');
    const chips = logRows().map((r) => r.querySelector('.iris-chip')?.textContent ?? '');
    expect(chips).toEqual(['READ', 'ACT', '']);
    expect(rowTexts()).toEqual(['snap', 'click Save', 'adding a beat']);
    p.destroy();
  });

  it('L4 act row updates to pass result without reordering', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const handle = p.log('act', 'Clicking Save');
    handle?.result('pass');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('✓');
    expect(rows[0]?.querySelector('.iris-res')?.className).toContain('iris-pass');
    p.destroy();
  });

  it('L5 act row updates to fail result', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const handle = p.log('act', 'Submit');
    handle?.result('fail');
    const rows = logRows();
    expect(rows[0]?.textContent).toContain('✗');
    expect(rows[0]?.querySelector('.iris-res')?.className).toContain('iris-fail');
    p.destroy();
  });

  it('L6 > logMax entries prunes oldest; count == logMax; newest present', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ logMax: 5 });
    p.mount();
    for (let i = 0; i < 20; i++) p.log('read', `line ${String(i)}`);
    const texts = rowTexts();
    expect(texts.length).toBe(5);
    expect(texts[0]).toBe('line 15');
    expect(texts[texts.length - 1]).toBe('line 19');
    expect(texts).not.toContain('line 0');
    p.destroy();
  });

  it('L7 logMax default is 50', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    for (let i = 0; i < 60; i++) p.log('read', `line ${String(i)}`);
    const texts = rowTexts();
    expect(texts.length).toBe(50);
    expect(texts).toContain('line 59');
    expect(texts).not.toContain('line 0');
    p.destroy();
  });

  it('L8 logMax configurable via setter after mount', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.logMax = 3;
    for (let i = 0; i < 10; i++) p.log('read', `line ${String(i)}`);
    expect(logRows().length).toBe(3);
    p.destroy();
  });

  it('L9 logMax <= 0 falls back to default (50)', () => {
    document.body.innerHTML = '';
    for (const bad of [0, -7]) {
      const p = new Presenter({ logMax: bad });
      p.mount();
      for (let i = 0; i < 60; i++) p.log('read', `line ${String(i)}`);
      expect(logRows().length).toBe(50);
      p.destroy();
    }
  });

  it('L10 empty/whitespace narration text is skipped', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('narration', '');
    p.log('narration', '   ');
    p.log('narration', 'real');
    expect(rowTexts()).toEqual(['real']);
    p.destroy();
  });

  it('L11 empty text for read/act is still skipped uniformly', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', '');
    expect(logRows().length).toBe(0);
    p.destroy();
  });

  it('L12 timestamps advance under a frozen app clock (proves nativeNow, not wall clock)', () => {
    document.body.innerHTML = '';
    const realPerfNow = performance.now.bind(performance);
    const realDateNow = Date.now.bind(Date);
    try {
      performance.now = () => 42;
      Date.now = () => 42;
      let t = 0;
      const p = new Presenter({ now: () => (t += 100) });
      p.mount();
      p.log('read', 'a');
      p.log('read', 'b');
      const ts = logRows().map((r) => r.querySelector('[data-iris-log-ts]')?.textContent ?? '');
      // Patched wall clock is frozen at 42; injected clock advances → rows must differ.
      expect(ts[0]).not.toBe(ts[1]);
      p.destroy();
    } finally {
      performance.now = realPerfNow;
      Date.now = realDateNow;
    }
  });

  it('L13 timestamp formatted as +elapsed from first row', () => {
    document.body.innerHTML = '';
    const times = [1000, 1400];
    let i = 0;
    const p = new Presenter({ now: () => times[i++] ?? 0 });
    p.mount();
    p.log('read', 'a');
    p.log('read', 'b');
    const ts = logRows().map((r) => r.querySelector('[data-iris-log-ts]')?.textContent ?? '');
    expect(ts[0]).toBe('+0.0s');
    expect(ts[1]).toBe('+0.4s');
    p.destroy();
  });

  it('L14 log text never leaks into buildSnapshot()', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({});
    p.mount();
    p.log('narration', 'secret-narration');
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('secret-narration');
    const logRoot = document.querySelector('[data-iris-log]');
    expect(logRoot).not.toBeNull();
    expect(isIgnored(logRoot as Element)).toBe(true);
    p.destroy();
  });

  it('L15 log container carries data-iris-* and is isIgnored', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const logRoot = document.querySelector('[data-iris-log]');
    expect(logRoot).not.toBeNull();
    expect(isIgnored(logRoot as Element)).toBe(true);
    p.destroy();
  });

  it('L16 log() before mount is a safe no-op', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    expect(() => p.log('read', 'x')).not.toThrow();
    expect(document.querySelector('[data-iris-log]')).toBeNull();
  });

  it('L17 auto-scroll: newest row sets scrollTop to scrollHeight', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const logRoot = document.querySelector('[data-iris-log]') as HTMLElement;
    for (let i = 0; i < 60; i++) p.log('read', `line ${String(i)}`);
    expect(logRoot.scrollTop).toBe(logRoot.scrollHeight);
    p.destroy();
  });

  it('L18 destroy clears log state; remount starts empty', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'a');
    p.log('read', 'b');
    p.destroy();
    const p2 = new Presenter({});
    p2.mount();
    expect(logRows().length).toBe(0);
    expect(document.querySelector('[data-iris-overlay]')).not.toBeNull();
    p2.destroy();
  });

  it('L19 narrate() legacy entry routes to log and appends', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.narrate('hello');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector('.iris-log-text')?.textContent).toBe('hello');
    expect(rows[0]?.querySelector('.iris-chip')?.textContent).toBe('');
    p.destroy();
  });

  it('L20 result() on non-act current row is tolerated', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'x');
    expect(() => p.result(true)).not.toThrow();
    const rows = logRows();
    expect(rows[0]?.textContent).not.toContain('✓');
    p.destroy();
  });
});

const dataOn = (): string | null =>
  document.querySelector('[data-iris-glow]')?.getAttribute('data-on') ?? null;
const dataBusy = (): string | null =>
  document.querySelector('[data-iris-glow]')?.getAttribute('data-busy') ?? null;

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
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    const hud = document.querySelector('[data-iris-hud]') as HTMLElement;
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

  it('3c expand toggle grows then collapses the log', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ border: 'session' });
    p.mount();
    const hud = document.querySelector('[data-iris-hud]') as HTMLElement;
    const btn = document.querySelector('[data-iris-expand]') as HTMLElement;
    btn.click();
    expect(hud.getAttribute('data-expanded')).toBe('1');
    btn.click();
    expect(hud.getAttribute('data-expanded')).toBe('0');
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
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 20);
    await flush();
    expect(p.glowPhase()).toBe('idle');
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
    expect(document.querySelector('[data-iris-mode]')?.getAttribute('data-iris-mode')).toBe(
      'reading',
    );
    expect(dataOn()).toBe('1');
    p.destroy();
  });
});

describe("presenter v2 border:'busy' back-compat (M5.8)", () => {
  it('10 reproduces M5.8 fade-out', async () => {
    document.body.innerHTML = '';
    let t = 0;
    const p = new Presenter({
      border: 'busy',
      now: () => t,
      idleAfterMs: FAST_IDLE_MS,
      glowFadeMs: FAST_FADE_MS,
    });
    p.mount();
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    const glow = document.querySelector('[data-iris-glow]') as HTMLElement;
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
    expect(document.querySelector('[data-iris-glow]')).toBeNull();
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
      border: 'busy',
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
      border: 'busy',
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
      border: 'busy',
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
      border: 'busy',
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

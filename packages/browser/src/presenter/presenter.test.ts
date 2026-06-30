import { describe, it, expect } from 'vitest';
import { PresenterMode } from '@reticle/protocol';
import { Presenter } from './presenter.js';
import { buildSnapshot } from '../dom/snapshot.js';
import { isIgnored } from '../dom/dom-ignore.js';

const FAST_IDLE_MS = 20;
const FAST_FADE_MS = 5;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Poll a predicate until true or timeout — robust to real-timer lateness under load (no flake). */
const until = async (pred: () => boolean, ms = 1000): Promise<boolean> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await wait(5);
  }
  return true;
};

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

    const hud = document.querySelector('[data-reticle-hud]');
    expect(hud).not.toBeNull();
    expect(isIgnored(hud as Element)).toBe(true);

    // The HUD's "idle"/"Save" text must NOT leak into the page snapshot.
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('idle');

    p.narrate('Clicking Save to verify the flow');
    expect(document.querySelector('[data-reticle-log] .reticle-log-text')?.textContent).toContain(
      'Clicking Save',
    );

    p.destroy();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });
});

describe('presenter reading vs acting', () => {
  it('READING sets mode + chip and hides the cursor', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    p.setMode(PresenterMode.READING);
    expect(p.mode).toBe(PresenterMode.READING);
    const chip = document.querySelector('[data-reticle-chip]');
    expect(chip?.textContent).toBe('READING');
    expect(chip?.getAttribute('data-mode')).toBe('reading');
    expect(document.querySelector('[data-reticle-cursor]')?.getAttribute('data-on')).toBe('0');

    p.destroy();
  });

  it('ACTING sets mode + chip', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    p.setMode(PresenterMode.ACTING);
    expect(p.mode).toBe(PresenterMode.ACTING);
    expect(document.querySelector('[data-reticle-chip]')?.textContent).toBe('ACTING');

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

const LOG_ROW_SEL = '[data-reticle-log] [data-reticle-log-row]';
const logRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(LOG_ROW_SEL));
const rowTexts = (): (string | null)[] =>
  logRows().map((r) => r.querySelector('.reticle-log-text')?.textContent ?? null);

describe('presenter v2 activity log', () => {
  it('log() appends a row with mode chip, text, timestamp', () => {
    document.body.innerHTML = '';
    const p = new Presenter({ now: () => 1000 });
    p.mount();
    p.log('read', 'Looking at the page');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector('.reticle-log-text')?.textContent).toBe('Looking at the page');
    expect(rows[0]?.querySelector('.reticle-chip')?.textContent).toBe('READ');
    expect(
      (rows[0]?.querySelector('[data-reticle-log-ts]')?.textContent ?? '').length,
    ).toBeGreaterThan(0);
    p.destroy();
  });

  it('three rapid narrations persist as three ordered rows (NONE overwritten)', () => {
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

  it('mixed read+act+narration ordering preserved', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'snap');
    p.log('act', 'click Save');
    p.log('narration', 'adding a beat');
    const chips = logRows().map((r) => r.querySelector('.reticle-chip')?.textContent ?? '');
    expect(chips).toEqual(['READ', 'ACT', '']);
    expect(rowTexts()).toEqual(['snap', 'click Save', 'adding a beat']);
    p.destroy();
  });

  it('act row updates to pass result without reordering', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const handle = p.log('act', 'Clicking Save');
    handle?.result('pass');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('✓');
    expect(rows[0]?.querySelector('.reticle-res')?.className).toContain('reticle-pass');
    p.destroy();
  });

  it('act row updates to fail result', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const handle = p.log('act', 'Submit');
    handle?.result('fail');
    const rows = logRows();
    expect(rows[0]?.textContent).toContain('✗');
    expect(rows[0]?.querySelector('.reticle-res')?.className).toContain('reticle-fail');
    p.destroy();
  });

  it('> logMax entries prunes oldest; count == logMax; newest present', () => {
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

  it('logMax default is 50', () => {
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

  it('logMax configurable via setter after mount', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.logMax = 3;
    for (let i = 0; i < 10; i++) p.log('read', `line ${String(i)}`);
    expect(logRows().length).toBe(3);
    p.destroy();
  });

  it('logMax <= 0 falls back to default (50)', () => {
    document.body.innerHTML = '';
    for (const bad of [0, -7]) {
      const p = new Presenter({ logMax: bad });
      p.mount();
      for (let i = 0; i < 60; i++) p.log('read', `line ${String(i)}`);
      expect(logRows().length).toBe(50);
      p.destroy();
    }
  });

  it('empty/whitespace narration text is skipped', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('narration', '');
    p.log('narration', '   ');
    p.log('narration', 'real');
    expect(rowTexts()).toEqual(['real']);
    p.destroy();
  });

  it('empty text for read/act is still skipped uniformly', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', '');
    expect(logRows().length).toBe(0);
    p.destroy();
  });

  it('timestamps advance under a frozen app clock (proves nativeNow, not wall clock)', () => {
    document.body.innerHTML = '';
    const realPerfNow = performance.now.bind(performance);
    const realDateNow = Date.now.bind(Date);
    try {
      performance.now = () => 42;
      Date.now = () => 42;
      let t = 0;
      const p = new Presenter({ now: () => (t += 1100) });
      p.mount();
      p.log('read', 'a');
      p.log('read', 'b');
      const ts = logRows().map((r) => r.querySelector('[data-reticle-log-ts]')?.textContent ?? '');
      // Patched wall clock is frozen at 42; injected clock advances >1s/row → rows must differ.
      expect(ts[0]).not.toBe(ts[1]);
      p.destroy();
    } finally {
      performance.now = realPerfNow;
      Date.now = realDateNow;
    }
  });

  it('timestamp is a human-readable duration since the first row', () => {
    document.body.innerHTML = '';
    const times = [1000, 3400];
    let i = 0;
    const p = new Presenter({ now: () => times[i++] ?? 0 });
    p.mount();
    p.log('read', 'a');
    p.log('read', 'b');
    const ts = logRows().map((r) => r.querySelector('[data-reticle-log-ts]')?.textContent ?? '');
    expect(ts[0]).toBe('0s');
    expect(ts[1]).toBe('2s'); // 2400ms elapsed → "2s"
    p.destroy();
  });

  it('liveness: a quiet agent shows a live, growing "idle · {duration}" clock', async () => {
    document.body.innerHTML = '';
    let clock = 0;
    const p = new Presenter({ now: () => clock, heartbeatMs: 8, idleNoticeMs: 20 });
    p.mount();
    p.sessionStart();
    p.status('Inspecting [testid=row-3700]');
    const act = (): string => document.querySelector('.reticle-act')?.textContent ?? '';
    expect(act()).toBe('Inspecting [testid=row-3700]'); // active → shows the action

    clock = 5000; // 5s since the last action — well past idleNoticeMs
    await wait(24); // let a heartbeat tick (8ms) fire
    expect(act()).toContain('idle');
    expect(act()).toContain('5s');
    expect(act()).toContain('since last action');

    p.status('Clicking Deploy'); // fresh activity → back to the live action text
    expect(act()).toBe('Clicking Deploy');
    p.destroy();
  });

  it('idle-end: a quiet session auto-ends, keeps the panel, and exposes the run state', async () => {
    document.body.innerHTML = '';
    let clock = 0;
    const p = new Presenter({
      now: () => clock,
      heartbeatMs: 8,
      idleNoticeMs: 20,
      idleEndMs: 100,
      sessionId: 'demo',
    });
    p.mount();
    p.sessionStart();
    p.log('read', 'Finding [testid=row-3700]', 'pass');
    expect(p.state).toBe('active');

    clock = 5000; // far past idleEndMs → the heartbeat should auto-end the session
    expect(await until(() => p.state === 'ended', 800)).toBe(true);

    // The panel (HUD/log) PERSISTS for analysis (only the border fades).
    expect(document.querySelector('[data-reticle-hud]')?.getAttribute('data-on')).toBe('1');
    expect(
      document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'),
    ).toBe('ended');

    // The run state is exportable and reflects what happened.
    const rs = p.runState();
    expect(rs.session).toBe('demo');
    expect(rs.state).toBe('ended');
    expect(rs.counts.reads).toBeGreaterThanOrEqual(1);
    expect(rs.counts.passes).toBeGreaterThanOrEqual(1);
    expect(rs.log.some((e) => e.text.includes('row-3700'))).toBe(true);

    // A fresh agent action revives the session (glow back on).
    clock = 5200;
    p.sessionStart();
    expect(p.state).toBe('active');
    expect(document.querySelector('[data-reticle-glow]')?.getAttribute('data-on')).toBe('1');
    p.destroy();
  });

  it('setIdleEndMs is floored (agent can not set a uselessly tiny window)', () => {
    document.body.innerHTML = '';
    let clock = 0;
    const p = new Presenter({ now: () => clock, heartbeatMs: 8, idleEndMs: 100, sessionId: 's' });
    p.mount();
    p.setIdleEndMs(1); // below the floor
    p.sessionStart();
    p.status('x');
    clock = 2000; // 2s quiet — above the tiny value we tried to set, but below the 5s floor
    // Give the heartbeat a few ticks; it must NOT have ended (floor kept the window ≥ 5s).
    return until(() => false, 40).then(() => {
      expect(p.state).toBe('active');
      p.destroy();
    });
  });

  it('log text never leaks into buildSnapshot()', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({});
    p.mount();
    p.log('narration', 'secret-narration');
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('secret-narration');
    const logRoot = document.querySelector('[data-reticle-log]');
    expect(logRoot).not.toBeNull();
    expect(isIgnored(logRoot as Element)).toBe(true);
    p.destroy();
  });

  it('log container carries data-reticle-* and is isIgnored', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const logRoot = document.querySelector('[data-reticle-log]');
    expect(logRoot).not.toBeNull();
    expect(isIgnored(logRoot as Element)).toBe(true);
    p.destroy();
  });

  it('log() before mount is a safe no-op', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    expect(() => p.log('read', 'x')).not.toThrow();
    expect(document.querySelector('[data-reticle-log]')).toBeNull();
  });

  it('auto-scroll: newest row sets scrollTop to scrollHeight', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const logRoot = document.querySelector('[data-reticle-log]') as HTMLElement;
    for (let i = 0; i < 60; i++) p.log('read', `line ${String(i)}`);
    expect(logRoot.scrollTop).toBe(logRoot.scrollHeight);
    p.destroy();
  });

  it('destroy clears log state; remount starts empty', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'a');
    p.log('read', 'b');
    p.destroy();
    const p2 = new Presenter({});
    p2.mount();
    expect(logRows().length).toBe(0);
    expect(document.querySelector('[data-reticle-overlay]')).not.toBeNull();
    p2.destroy();
  });

  it('narrate() legacy entry routes to log and appends', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.narrate('hello');
    const rows = logRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector('.reticle-log-text')?.textContent).toBe('hello');
    expect(rows[0]?.querySelector('.reticle-chip')?.textContent).toBe('');
    p.destroy();
  });

  it('result() on non-act current row is tolerated', () => {
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
  document.querySelector('[data-reticle-glow]')?.getAttribute('data-on') ?? null;
const dataBusy = (): string | null =>
  document.querySelector('[data-reticle-glow]')?.getAttribute('data-busy') ?? null;

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

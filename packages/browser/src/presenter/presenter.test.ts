import { describe, it, expect } from 'vitest';
import { PresenterMode } from '@reticlehq/core';
import { Presenter } from './presenter.js';
import { buildSnapshot } from '../dom/snapshot.js';
import { isIgnored } from '../dom/dom-ignore.js';
import { until, wait } from './presenter-test-helpers.js';

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
});

import { describe, expect, it } from 'vitest';
import { parseHudNotices, selectNotices, type HudNoticeEntry } from './hud-notices.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');

const entry = (over: Partial<HudNoticeEntry> = {}): HudNoticeEntry => ({
  id: 'harness-personas',
  title: 'Let Reticle drive your app for you',
  ...over,
});

describe('the HUD notices file', () => {
  it('keeps the valid notices and drops each invalid one on its own', () => {
    const notices = parseHudNotices({
      version: 1,
      notices: [
        { id: 'good', title: 'Fine', cta: { label: 'See', url: 'https://reticle.sh/harness' } },
        { id: 'foreign-link', title: 'Bad', cta: { label: 'Go', url: 'https://evil.example/x' } },
        { id: 'plain-http', title: 'Bad', cta: { label: 'Go', url: 'http://reticle.sh/x' } },
        { id: 'Not An Id', title: 'Bad' },
        { id: 'no-title' },
      ],
    });
    expect(notices.map((n) => n.id)).toEqual(['good']);
  });

  it('answers nothing for a file it does not understand, never throws', () => {
    expect(parseHudNotices('<html>')).toEqual([]);
    expect(parseHudNotices({ version: 2, notices: [{ id: 'x', title: 'y' }] })).toEqual([]);
    expect(parseHudNotices(null)).toEqual([]);
  });

  it('only links to our own sites', () => {
    const ok = (url: string): boolean =>
      1 === parseHudNotices({ version: 1, notices: [entry({ cta: { label: 'Go', url } })] }).length;
    expect(ok('https://app.reticle.sh/settings?group=billing')).toBe(true);
    expect(ok('https://docs.reticle.sh/harness')).toBe(true);
    expect(ok('https://github.com/reticlehq/reticle')).toBe(true);
    expect(ok('https://github.com/someone-else/repo')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
  });
});

describe('choosing what this HUD shows', () => {
  const ctx = { signedIn: true, entitled: false, sdkVersion: '3.6.0', now: NOW };

  it('respects the audience, the schedule and the SDK version, heaviest first', () => {
    const shown = selectNotices(
      [
        entry({ id: 'light', weight: 1 }),
        entry({ id: 'heavy', weight: 9 }),
        entry({ id: 'signed-out-only', audience: { signedIn: false } }),
        entry({ id: 'entitled-only', audience: { entitled: true } }),
        entry({ id: 'not-yet', from: '2026-11-01' }),
        entry({ id: 'over', until: '2026-10-01' }),
        entry({ id: 'newer-sdk', minSdk: '3.7.0' }),
      ],
      ctx,
    );
    expect(shown.map((n) => n.id)).toEqual(['heavy', 'light']);
  });

  it('treats an unknown account state as matching only "any"', () => {
    const shown = selectNotices(
      [entry({ id: 'any' }), entry({ id: 'signed-in-only', audience: { signedIn: true } })],
      { ...ctx, signedIn: undefined },
    );
    expect(shown.map((n) => n.id)).toEqual(['any']);
  });

  it('shows at most five, and only the fields the HUD renders', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ id: `n${String(i)}`, weight: i }));
    const shown = selectNotices(many, ctx);
    expect(shown).toHaveLength(5);
    expect(Object.keys(shown[0] ?? {}).sort()).toEqual(['id', 'title']);
  });
});

import { hashPayload } from '@/memory/cloud/sync-hash.js';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPACT_DEFECT_LIMIT, emptyImpactCounts } from '@reticlehq/core';
import { ImpactStore, applyDelta, atLeastProject, isoDay, readScope } from './impact-store.js';

const DAY = 86_400_000;

function scopeAt(now: number) {
  return readScope(join(mkdtempSync(join(tmpdir(), 'impact-')), 'missing.json'), now);
}

describe('the impact record', () => {
  it('starts empty and survives a missing file', () => {
    const scope = scopeAt(1000);
    expect(scope.counts).toEqual(emptyImpactCounts());
    expect(scope.days).toEqual([]);
    expect(scope.since).toBe(1000);
  });

  it('folds a delta into totals and today', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const after = applyDelta(scopeAt(now), { calls: 1, verdicts: 1, passed: 1 }, now);
    expect(after.counts.verdicts).toBe(1);
    expect(after.days).toHaveLength(1);
    expect(after.days[0]?.date).toBe(isoDay(now));
    expect(after.days[0]?.counts.passed).toBe(1);
  });

  /**
   * A saving is a comparison, so it may never be reported without the run it is compared against.
   * The number is allowed to change; a number with no stated basis is not.
   */
  it('always states what a saving is measured against', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const after = applyDelta(scopeAt(now), { verdicts: 3, failed: 1, tokensReturned: 400 }, now);
    expect(after.savings.tokens.value).toBeGreaterThan(0);
    expect(after.savings.tokens.basis.length).toBeGreaterThan(10);
    expect(after.savings.minutes.basis).toContain('defect');
  });

  it('counts a streak only over consecutive days', () => {
    const day1 = Date.parse('2026-08-18T10:00:00');
    let scope = applyDelta(scopeAt(day1), { verdicts: 1 }, day1);
    expect(scope.records.streakDays).toBe(1);
    scope = applyDelta(scope, { verdicts: 1 }, day1 + DAY);
    expect(scope.records.streakDays, 'the next day continues it').toBe(2);
    scope = applyDelta(scope, { verdicts: 1 }, day1 + DAY * 4);
    expect(scope.records.streakDays, 'a gap starts over').toBe(1);
    expect(scope.records.bestStreakDays, 'the best is remembered').toBe(2);
  });

  /**
   * The machine-wide record is shared by every daemon on the box and was also written by test runs
   * with a frozen clock, so its days arrived out of order: `10-03, 1970-01-01, 10-03, …, 10-05`. The
   * streak was a counter that only compared the newest bucket with the one before it, so any stray
   * day in between reset it to 1 — the machine view read "1 day streak" no matter what.
   */
  it('keeps a streak across days that arrive out of order', () => {
    const day1 = Date.parse('2026-10-03T10:00:00');
    let scope = applyDelta(scopeAt(day1), { calls: 1 }, day1);
    scope = applyDelta(scope, { calls: 1 }, 5_000); // a writer with a frozen clock
    scope = applyDelta(scope, { calls: 1 }, day1 + DAY);
    scope = applyDelta(scope, { calls: 1 }, day1); // an older delta flushed late by another daemon
    scope = applyDelta(scope, { calls: 1 }, day1 + DAY * 2);
    expect(scope.records.streakDays).toBe(3);
    // One bucket per day, oldest first, so the next fold and the 30-day chart read the same thing.
    const dates = scope.days.map((d) => d.date);
    expect(dates).toEqual([...new Set(dates)].sort());
    expect(scope.days.find((d) => d.date === isoDay(day1))?.counts.calls).toBe(2);
  });

  it('writes both scopes atomically and reads them back', () => {
    const root = mkdtempSync(join(tmpdir(), 'impact-project-'));
    // Its own home: without `globalRoot` this flush wrote a 1970 day into the developer's real
    // ~/.reticle/impact.json on every test run, which is what kept the machine streak at 1.
    const store = new ImpactStore({
      reticleRoot: join(root, '.reticle'),
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-home-')),
      projectName: 'demo',
      now: () => 5_000,
    });
    store.record({ calls: 2, verdicts: 1, failed: 1, tokensReturned: 120, drivingMs: 900 });
    store.flush();
    const onDisk: unknown = JSON.parse(readFileSync(join(root, '.reticle', 'impact.json'), 'utf8'));
    expect((onDisk as { counts: { calls: number } }).counts.calls).toBe(2);
    expect(store.snapshot().projectName).toBe('demo');
    expect(store.snapshot().project.counts.failed).toBe(1);
  });
});

/**
 * Both entry points open the record, or the HUD is handed nothing on connect.
 *
 * `start` and `startDaemon` each wire their own world, and only one of them had the line - so in
 * the process that actually serves people, the record was opened lazily by the first TOOL call.
 * A tab that connected before then was pushed nothing, and the report said "nothing recorded yet"
 * over a file with history in it. This is the cheap structural check that both keep the line.
 */
describe('the daemon opens the impact record at startup', () => {
  it('is initialised by both server entry points', () => {
    const src = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const startBody = src.slice(
      src.indexOf('export async function start('),
      src.indexOf('export async function startDaemon('),
    );
    const daemonBody = src.slice(src.indexOf('export async function startDaemon('));
    expect(startBody, '`start` opens the record').toContain('initImpact(');
    expect(daemonBody, '`startDaemon` opens the record - this is the one that serves').toContain(
      'initImpact(',
    );
  });
});

/**
 * "Longest run" is the longest SESSION, not the longest tool call.
 *
 * It used to be fed each call's own duration, so the report's superlative was a few hundred
 * milliseconds however long the agent actually worked - a number that could never mean what its
 * label said.
 */
describe('the longest-run record', () => {
  it('takes a session lifetime and ignores per-call durations', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = applyDelta(scopeAt(now), { calls: 1, drivingMs: 480 }, now);
    expect(scope.records.longestRunMs, 'one click is not a run').toBe(0);
    scope = applyDelta(scope, { calls: 1 }, now, { runMs: 742_000 });
    expect(scope.records.longestRunMs).toBe(742_000);
    scope = applyDelta(scope, { calls: 1 }, now, { runMs: 9_000 });
    expect(scope.records.longestRunMs, 'a shorter run does not beat the record').toBe(742_000);
  });
});

/**
 * The short list of what broke.
 *
 * `counts.failed` says how many; this says which. The invariants that matter are that it stays
 * SHORT (a counters file must not become a log), stays CURRENT (newest first, or after a week it is
 * a list about the past), and that a record written by an older build still parses — a defect list
 * is not worth losing somebody's whole history over.
 */
describe('the defect list', () => {
  const defect = (title: string, at = 1) => ({ at, title });

  it('remembers what broke, not just that something did', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const scope = applyDelta(scopeAt(now), { calls: 1, verdicts: 1, failed: 1 }, now, {
      defect: defect('Sign In'),
    });
    expect(scope.counts.failed).toBe(1);
    expect(scope.defects.map((d) => d.title)).toEqual(['Sign In']);
  });

  it('keeps the newest first, so the list is what is broken NOW', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = scopeAt(now);
    for (const title of ['first', 'second', 'third']) {
      scope = applyDelta(scope, { failed: 1 }, now, { defect: defect(title) });
    }
    expect(scope.defects.map((d) => d.title)).toEqual(['third', 'second', 'first']);
  });

  it('stays bounded, however long the session runs', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = scopeAt(now);
    for (let i = 0; i < 50; i += 1) {
      scope = applyDelta(scope, { failed: 1 }, now, { defect: defect(`d${String(i)}`) });
    }
    expect(scope.defects).toHaveLength(IMPACT_DEFECT_LIMIT);
    expect(scope.defects[0]?.title, 'newest survives the cap').toBe('d49');
    expect(scope.counts.failed, 'the COUNT is not capped — only the list is').toBe(50);
  });

  it('leaves the list alone on a call that caught nothing', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const withOne = applyDelta(scopeAt(now), { failed: 1 }, now, { defect: defect('Sign In') });
    const after = applyDelta(withOne, { calls: 1, passed: 1, verdicts: 1 }, now);
    expect(after.defects.map((d) => d.title)).toEqual(['Sign In']);
  });

  it('reads a record written before defects existed, rather than discarding it', () => {
    // The whole point of defaulting the field: an older impact.json is somebody's history, and a
    // parse failure here would silently reset their streak, their records and their totals.
    const dir = mkdtempSync(join(tmpdir(), 'impact-old-'));
    const path = join(dir, 'impact.json');
    writeFileSync(
      path,
      JSON.stringify({
        counts: { ...emptyImpactCounts(), calls: 7, failed: 2 },
        days: [],
        records: {
          longestRunMs: 5,
          bestVerdictDay: 1,
          bestDefectDay: 1,
          streakDays: 3,
          bestStreakDays: 3,
        },
        savings: { tokens: { value: 1, basis: 'b' }, minutes: { value: 1, basis: 'b' } },
        since: 10,
      }),
      'utf8',
    );
    const scope = readScope(path, 999);
    expect(scope.counts.calls, 'the old history survived').toBe(7);
    expect(scope.records.streakDays).toBe(3);
    expect(scope.defects).toEqual([]);
  });
});

/** The HUD's link to the dashboard: present only when `reticle link` recorded one. */
describe('the dashboard link', () => {
  it('is absent for a project that is not linked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-nolink-'));
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBeUndefined();
  });

  it('is read from the link file `reticle link` writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-link-'));
    writeFileSync(
      join(dir, 'cloud.json'),
      JSON.stringify({
        projectId: 'web',
        url: 'https://api.test',
        dashboardUrl: 'https://console.test/issues?project=web',
      }),
      'utf8',
    );
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBe(
      'https://console.test/issues?project=web',
    );
  });

  /*
   * The daemon builds one store per project and keeps it for its whole life, while `reticle link`
   * runs in another terminal. Read once at construction, a project linked after the daemon started
   * said "Not linked" on every snapshot, reloads included, until the daemon was restarted.
   */
  it('is read per snapshot, so a link made while the daemon runs shows without a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-late-link-'));
    const store = new ImpactStore({ reticleRoot: dir, notices: { read: () => [] } });
    expect(store.snapshot().dashboardUrl).toBeUndefined();
    writeFileSync(
      join(dir, 'cloud.json'),
      JSON.stringify({ dashboardUrl: 'https://c.test/p/web' }),
    );
    expect(store.snapshot().dashboardUrl).toBe('https://c.test/p/web');
  });

  it('is absent — not crashed — when the link file is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-bad-'));
    writeFileSync(join(dir, 'cloud.json'), '{not json', 'utf8');
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBeUndefined();
  });
});

describe('the sync status in the snapshot', () => {
  it('is there for a linked project, and absent for one that is not', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'impact-sync-'));
    const reticleRoot = join(projectDir, '.reticle');
    const base = {
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-sync-home-')),
      notices: { read: () => [] },
    };
    expect(new ImpactStore({ ...base, reticleRoot }).snapshot()).not.toHaveProperty('sync');
    mkdirSync(reticleRoot, { recursive: true });
    writeFileSync(
      join(reticleRoot, 'cloud.json'),
      JSON.stringify({ dashboardUrl: 'https://app.reticle.sh/p/x' }),
    );
    const linked = new ImpactStore({ ...base, reticleRoot }).snapshot();
    expect(linked.sync).toMatchObject({ status: 'on-platform', runs: 0, onPlatform: 0 });
  });

  // An unlinked folder with runs was silent in the HUD: those runs were on this machine only.
  it('says how many runs an unlinked project holds that nothing will send', () => {
    const reticleRoot = join(mkdtempSync(join(tmpdir(), 'impact-unsent-')), '.reticle');
    mkdirSync(join(reticleRoot, 'runs'), { recursive: true });
    writeFileSync(join(reticleRoot, 'runs', 'r1.json'), JSON.stringify({ runId: 'r1' }));
    const snap = new ImpactStore({
      reticleRoot,
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-unsent-home-')),
      notices: { read: () => [] },
    }).snapshot();
    expect(snap.sync).toMatchObject({ status: 'local-only', pending: 1 });
    expect(String(snap.sync?.['said'])).toContain('reticle connect');
  });

  // A flow saved in an unlinked folder with no run beside it was only a daemon log line.
  it('counts the flows an unlinked project holds in the same not-sent number', () => {
    const reticleRoot = join(mkdtempSync(join(tmpdir(), 'impact-unsent-flows-')), '.reticle');
    mkdirSync(join(reticleRoot, 'flows'), { recursive: true });
    writeFileSync(join(reticleRoot, 'flows', 'checkout.json'), JSON.stringify({ name: 'c' }));
    const snap = new ImpactStore({
      reticleRoot,
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-unsent-flows-home-')),
      notices: { read: () => [] },
    }).snapshot();
    expect(snap.sync).toMatchObject({ status: 'local-only', pending: 1, runs: 0, flows: 1 });
    expect(String(snap.sync?.['said'])).toContain('1 flow(s)');
  });

  it('links the newest run the platform holds, on its own dashboard page', () => {
    const reticleRoot = join(mkdtempSync(join(tmpdir(), 'impact-runurl-')), '.reticle');
    mkdirSync(join(reticleRoot, 'runs'), { recursive: true });
    const payload = { runId: 'r9', createdAt: 3 };
    writeFileSync(join(reticleRoot, 'runs', 'r9.json'), JSON.stringify(payload));
    writeFileSync(
      join(reticleRoot, 'cloud.json'),
      JSON.stringify({ dashboardUrl: 'https://app.reticle.sh/p/x' }),
    );
    writeFileSync(
      join(reticleRoot, 'cloud-state.json'),
      JSON.stringify({ sentRunHashes: { r9: hashPayload(payload) } }),
    );
    const snap = new ImpactStore({
      reticleRoot,
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-runurl-home-')),
      notices: { read: () => [] },
    }).snapshot();
    expect(snap.sync?.['runUrl']).toBe('https://app.reticle.sh/runs/r9');
  });
});

describe('Reticle Coverage in the snapshot', () => {
  it('carries the levels its source reports, and nothing when there is none', () => {
    const base = {
      reticleRoot: join(mkdtempSync(join(tmpdir(), 'impact-cov-')), '.reticle'),
      globalRoot: mkdtempSync(join(tmpdir(), 'impact-cov-home-')),
      notices: { read: () => [] },
    };
    expect(
      new ImpactStore({ ...base, coverage: () => ({ proved: 40 }) }).snapshot().coverage,
    ).toEqual({ proved: 40 });
    expect(new ImpactStore({ ...base, coverage: () => undefined }).snapshot()).not.toHaveProperty(
      'coverage',
    );
  });
});

/** The rail's notices: chosen by the daemon for THIS machine, never the whole file. */
describe('the notices in the snapshot', () => {
  const home = (): string => mkdtempSync(join(tmpdir(), 'impact-notices-home-'));
  const entries = [
    { id: 'for-everyone', title: 'Hello' },
    { id: 'signed-out-only', title: 'Sign in', audience: { signedIn: false } },
    { id: 'needs-newer', title: 'Later', minSdk: '9.0.0' },
  ];

  it('carries only the notices that apply to this machine', () => {
    const store = new ImpactStore({
      reticleRoot: join(mkdtempSync(join(tmpdir(), 'impact-notices-')), '.reticle'),
      globalRoot: home(),
      account: () => ({ signedIn: true }),
      notices: { read: () => entries },
      sdkVersion: '3.6.0',
    });
    expect(store.snapshot().notices).toEqual([{ id: 'for-everyone', title: 'Hello' }]);
  });

  it('leaves the field out when nothing applies, so the bundled slides show', () => {
    const store = new ImpactStore({
      reticleRoot: join(mkdtempSync(join(tmpdir(), 'impact-notices-')), '.reticle'),
      globalRoot: home(),
      notices: { read: () => [] },
    });
    expect(store.snapshot().notices).toBeUndefined();
  });
});

describe('a streak longer than the daily window', () => {
  it('keeps counting past the days the record keeps', () => {
    let scope = scopeAt(Date.parse('2026-01-01T10:00:00'));
    for (let day = 0; day < 60; day++) {
      const now = Date.parse('2026-01-01T10:00:00') + day * DAY;
      scope = applyDelta(scope, { verdicts: 1 }, now);
    }
    expect(scope.days.length).toBeLessThan(60);
    expect(scope.records.streakDays).toBe(60);
  });
});

describe('all time, beside one project', () => {
  it('is never smaller than the project, even when the project kept history the machine did not', () => {
    const now = Date.parse('2026-10-06T10:00:00');
    const project = applyDelta(
      scopeAt(now - 30 * DAY),
      { calls: 40, verdicts: 12, failed: 3 },
      now,
    );
    const global = applyDelta(scopeAt(now - DAY), { calls: 5, verdicts: 2 }, now);
    const shown = atLeastProject(global, project);
    expect(shown.counts.calls).toBe(40);
    expect(shown.counts.verdicts).toBe(12);
    expect(shown.counts.failed).toBe(3);
    expect(shown.since).toBe(now - 30 * DAY);
  });
});

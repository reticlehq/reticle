import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryInvite, JOURNAL_FILE_VERSION, Verified } from '@reticlehq/core';
import { reportFor } from './report-command.js';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirSync(d);
});

const HOUR_MS = 60 * 60 * 1000;

/** A project whose `.reticle/sessions/<id>/actions.jsonl` holds one verdict per entry. */
function project(
  sessions: Record<string, { verdicts: Verified[]; ageMs: number }>,
  now: number,
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'reticle-report-'));
  dirs.push(cwd);
  for (const [id, { verdicts, ageMs }] of Object.entries(sessions)) {
    const dir = join(cwd, '.reticle', 'sessions', id);
    mkdirSync(dir, { recursive: true });
    const lines = verdicts.map((verified, i) =>
      JSON.stringify({
        v: JOURNAL_FILE_VERSION,
        actionId: `c${String(i)}`,
        tool: 'reticle_act_and_wait',
        args: {},
        effect: { claim: `claim ${String(i)}`, verified },
        tRange: { from: 0, to: 1 },
        at: 0,
      }),
    );
    const file = join(dir, 'actions.jsonl');
    writeFileSync(file, lines.join('\n') + '\n');
    const at = (now - ageMs) / 1000;
    utimesSync(file, at, at);
  }
  return cwd;
}

const NOW = 1_800_000_000_000;

describe('reportFor — the session gap, read from disk with no daemon', () => {
  it('reports the NEWEST session', async () => {
    const cwd = project(
      {
        sold: { verdicts: [Verified.NO], ageMs: 2 * HOUR_MS },
        snew: { verdicts: [Verified.YES, Verified.UNKNOWN], ageMs: 1000 },
      },
      NOW,
    );
    const out = await reportFor({ cwd, now: NOW, treeChanged: true });
    expect(out.lines[0]).toBe('session snew');
    expect(out.lines).toContain('1 of 2 claims held');
    // The person reading a report is the person worth talking to.
    expect(out.lines.at(-1)).toBe(DiscoveryInvite.HUMAN);
  });

  it('as a hook: speaks on a changed tree with no yes', async () => {
    const cwd = project({ s1: { verdicts: [Verified.UNKNOWN], ageMs: 1000 } }, NOW);
    const out = await reportFor({ cwd, now: NOW, treeChanged: true, hook: true });
    expect(out.lines).toEqual(['Reticle: not verified. 1 claim: 1 unknown', DiscoveryInvite.HUMAN]);
  });

  it('as a hook: silent after a yes', async () => {
    const cwd = project({ s1: { verdicts: [Verified.YES], ageMs: 1000 } }, NOW);
    expect((await reportFor({ cwd, now: NOW, treeChanged: true, hook: true })).lines).toEqual([]);
  });

  it('as a hook: silent when nothing in the tree changed', async () => {
    const cwd = project({ s1: { verdicts: [Verified.UNKNOWN], ageMs: 1000 } }, NOW);
    expect((await reportFor({ cwd, now: NOW, treeChanged: false, hook: true })).lines).toEqual([]);
  });

  // A drive from this morning must not answer for this turn: the hook asks about NOW.
  it('as a hook: a session older than the window is not this turn', async () => {
    const cwd = project({ s1: { verdicts: [Verified.YES], ageMs: 2 * HOUR_MS } }, NOW);
    const out = await reportFor({ cwd, now: NOW, treeChanged: true, hook: true });
    expect(out.lines).toEqual([
      'Reticle: not verified. No claim was checked this session',
      DiscoveryInvite.HUMAN,
    ]);
  });

  // From a headless run: the agent proved 3 claims, but before `reticle init` its journal lived in
  // ~/.reticle/unmatched, and the hook said "No claim was checked this session".
  it('as a hook: counts a session the daemon filed under ~/.reticle/unmatched', async () => {
    const cwd = project({}, NOW);
    const home = project({}, NOW);
    const filed = join(home, '.reticle', 'unmatched', 'origin-abc', 'sessions', 'lease-1');
    mkdirSync(filed, { recursive: true });
    const line = JSON.stringify({
      v: JOURNAL_FILE_VERSION,
      actionId: 'c0',
      tool: 'reticle_act_and_wait',
      args: {},
      effect: { claim: 'order carries the promo', verified: Verified.YES },
      tRange: { from: 0, to: 1 },
      at: 0,
    });
    writeFileSync(join(filed, 'actions.jsonl'), `${line}\n`);
    const at = (NOW - 1000) / 1000;
    utimesSync(join(filed, 'actions.jsonl'), at, at);
    const out = await reportFor({ cwd, home, now: NOW, treeChanged: true, hook: true });
    expect(out.lines).toEqual([]);
  });

  it('says there is nothing to report in a project with no sessions', async () => {
    const cwd = project({}, NOW);
    expect((await reportFor({ cwd, now: NOW, treeChanged: true })).lines).toEqual([
      'no claims this session, so nothing was verified',
      DiscoveryInvite.HUMAN,
    ]);
  });
});

/** A project with one Harness drive record in `.reticle/runs/`, as the daemon writes it. */
function withDrive(record: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'reticle-report-drive-'));
  dirs.push(cwd);
  const dir = join(cwd, '.reticle', 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(record['harnessRun'])}.drive.json`), JSON.stringify(record));
  return cwd;
}

const drive = (over: Record<string, unknown>): Record<string, unknown> => ({
  harnessRun: 'harness-abc',
  status: 'running',
  origin: 'agent',
  startedAt: NOW - 60_000,
  steps: 3,
  lastLine: 'step 3',
  ...over,
});

describe('reportFor — as a hook, it keeps the agent while its Harness drive runs', () => {
  it('blocks the stop and names the poll call while the agent’s drive runs', async () => {
    const cwd = withDrive(drive({}));
    const out = await reportFor({ cwd, now: NOW, treeChanged: false, hook: true });
    expect(out.block).toContain('harness-abc');
    expect(out.block).toContain('reticle_verify {action:"explore", runId:"harness-abc"}');
  });

  it('lets the agent stop once the drive ended', async () => {
    const cwd = withDrive(drive({ status: 'done', endedAt: NOW - 1000 }));
    const out = await reportFor({ cwd, now: NOW, treeChanged: false, hook: true });
    expect(out.block).toBeUndefined();
  });

  it('lets the agent stop when the record is older than the bound: its daemon is gone', async () => {
    const cwd = withDrive(drive({ startedAt: NOW - 2 * HOUR_MS }));
    const out = await reportFor({ cwd, now: NOW, treeChanged: false, hook: true });
    expect(out.block).toBeUndefined();
  });

  it('does not block for a drive a person started from the HUD', async () => {
    const cwd = withDrive(drive({ origin: 'hud' }));
    const out = await reportFor({ cwd, now: NOW, treeChanged: false, hook: true });
    expect(out.block).toBeUndefined();
  });

  it('never blocks outside the hook', async () => {
    const cwd = withDrive(drive({}));
    const out = await reportFor({ cwd, now: NOW, treeChanged: true });
    expect(out.block).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { hashPayload } from '@/memory/cloud/sync-hash.js';
import {
  SyncStatus,
  dashboardRunUrl,
  describeSync,
  overallStatus,
  seeRunLine,
  summarizeSync,
} from './sync-status.js';

const run = (runId: string, n = 1) => ({ runId, payload: { runId, n } });

describe('where this project stands with the platform', () => {
  it('reads each run as on the platform, refused in its current form, or waiting', () => {
    const accepted = run('a');
    const changedSince = run('b', 2);
    const refused = run('c');
    const summary = summarizeSync({
      linked: true,
      runs: [accepted, changedSince, refused, run('d')],
      state: {
        sentRunHashes: { a: hashPayload(accepted.payload), b: hashPayload(run('b', 1).payload) },
        refusedRuns: {
          c: {
            reason: 'run schema 9 is not read here',
            payloadHash: hashPayload(refused.payload),
            acceptsHash: 'x',
          },
        },
        lastPushAt: 1_000,
      },
    });
    expect(summary).toMatchObject({ runs: 4, onPlatform: 1, pending: 2 });
    expect(summary.refused).toEqual([{ runId: 'c', reason: 'run schema 9 is not read here' }]);
    expect(overallStatus(summary)).toBe(SyncStatus.REFUSED);
    expect(describeSync(summary, 6_000)).toContain('1 of 4 run(s) on the platform');
    expect(describeSync(summary, 6_000)).toContain('c: run schema 9 is not read here');
    expect(describeSync(summary, 6_000)).toContain('last push 5s ago');
  });

  it('is local only on a machine that is not linked', () => {
    const summary = summarizeSync({ linked: false, runs: [run('a')], state: {} });
    expect(overallStatus(summary)).toBe(SyncStatus.LOCAL_ONLY);
    expect(describeSync(summary, 0)).toContain('exist only on this machine');
  });

  it('says a failed push, even when every run already went up', () => {
    const a = run('a');
    const summary = summarizeSync({
      linked: true,
      runs: [a],
      state: { sentRunHashes: { a: hashPayload(a.payload) }, lastError: 'platform answered 503' },
    });
    expect(overallStatus(summary)).toBe(SyncStatus.PENDING);
    expect(describeSync(summary, 0)).toContain('the last push failed: platform answered 503');
  });
});

describe('the run a person is sent to', () => {
  it('names the newest run the platform holds in its current form', () => {
    const older = { runId: 'old', payload: { runId: 'old', createdAt: 1 } };
    const newer = { runId: 'new', payload: { runId: 'new', createdAt: 5 } };
    const unsent = { runId: 'unsent', payload: { runId: 'unsent', createdAt: 9 } };
    const summary = summarizeSync({
      linked: true,
      runs: [older, newer, unsent],
      state: {
        sentRunHashes: { old: hashPayload(older.payload), new: hashPayload(newer.payload) },
      },
    });
    expect(summary.latestOnPlatform).toBe('new');
  });

  it('links the console’s run page at the dashboard’s origin', () => {
    expect(seeRunLine('https://app.reticle.sh/projects/shop', 'run 1')).toBe(
      'See it in your dashboard: https://app.reticle.sh/runs/run%201',
    );
    expect(dashboardRunUrl('https://app.reticle.sh/', 'r2')).toBe('https://app.reticle.sh/runs/r2');
  });
});

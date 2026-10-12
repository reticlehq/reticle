import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PredicateKind, QueryBy, ReticleTool, type FlowFile } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from './flows.js';
import { RecordingStore, type RecordedStep } from './recording/tape/recordings.js';
import { establishedState, journeyFingerprint } from './flow-journey.js';

/**
 * What a saved drive has to carry for a map of the app to be drawn from it — the page each step ran
 * on and led to, why it was driven, who drove it, where it starts and ends — and that one journey
 * driven in many sessions is one file.
 */
const PREFIX = 'drive-';
/** A bound, not a measurement: these round-trip several flows through a real temp directory. */
const JOURNEY_SAVE_TIMEOUT_MS = 30_000;

const click = (testid: string, extra: Partial<RecordedStep> = {}): RecordedStep => ({
  tool: ReticleTool.ACT,
  args: { by: QueryBy.TESTID, value: testid, action: 'click', args: {} },
  stable: true,
  ...extra,
});

const opened: RecordedStep[] = [
  click('issue-open', { page: '/issues', endPage: '/issues/7', intent: 'Close an issue' }),
  click('issue-close', {
    page: '/issues/7',
    expect: { kind: PredicateKind.SIGNAL, name: 'issue:closed' },
  }),
];

describe('a saved drive', () => {
  let dir: string;
  let store: FlowStore;
  let now = 1000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-journey-'));
    now = 1000;
    store = new FlowStore(createNodeFileSystem(), join(dir, '.reticle'), { now: () => now });
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  const drive = async (name: string, steps: RecordedStep[], startPath = '/issues') => {
    now += 1;
    return store.saveJourney({ name, version: 1, steps, startPath }, undefined, PREFIX);
  };
  const load = async (name: string): Promise<FlowFile> => {
    const res = await store.load(name);
    if (!res.ok) throw new Error(`${name}: ${res.code}`);
    return res.value;
  };

  it('records the page every step ran on and the page it led to', async () => {
    await drive('drive-close-an-issue', opened);
    const flow = await load('drive-close-an-issue');
    expect(flow.steps.map((s) => [s.page, s.endPage])).toEqual([
      ['/issues', '/issues/7'],
      ['/issues/7', undefined],
    ]);
  });

  it('carries the action intent into the flow', async () => {
    await drive('drive-close-an-issue', opened);
    expect((await load('drive-close-an-issue')).intent).toBe('Close an issue');
  });

  it('declares where it starts and ends, in the form canFollow compares', async () => {
    await drive('drive-close-an-issue', opened);
    const flow = await load('drive-close-an-issue');
    expect(flow.requires).toEqual([{ kind: PredicateKind.ROUTE, pathname: '/issues' }]);
    expect(flow.ensures).toEqual([{ kind: PredicateKind.ROUTE, pathname: '/issues/7' }]);
    // A start-page claim is discharged by replay arriving there: it must not gate the run or stop
    // the reset, or every auto-saved flow would replay from wherever the tab happened to be.
    expect(establishedState(flow)).toEqual([]);
  });

  it('records who made it', async () => {
    now += 1;
    await store.saveJourney(
      {
        name: 'drive-x',
        version: 1,
        steps: opened,
        author: { agent: 'claude-code', person: 'a@b.c' },
      },
      undefined,
      PREFIX,
    );
    expect((await load('drive-x')).author).toEqual({ agent: 'claude-code', person: 'a@b.c' });
  });

  it('merges a second drive of the same journey into the first, filling its gaps', async () => {
    const bare = opened.map(({ intent: _intent, ...step }) => step);
    await drive('drive-issue-closed', bare);
    await drive('drive-close-an-issue', opened);
    expect(await store.list()).toEqual(['drive-issue-closed']);
    // The older name survives; the newer drive supplied the intent it lacked.
    expect((await load('drive-issue-closed')).intent).toBe('Close an issue');
  });

  it(
    'collapses copies saved before merging existed',
    async () => {
      const other = [click('settings-save', { expect: { kind: PredicateKind.SIGNAL, name: 's' } })];
      // Written with plain save, as teardown used to: one near-copy per session.
      for (const name of ['drive-a-s1', 'drive-a-s2', 'drive-a-s3']) {
        now += 1;
        await store.save({ name, version: 1, steps: opened, startPath: '/issues' });
      }
      await drive('drive-settings', other, '/settings');
      expect(await store.list()).toEqual(['drive-a-s1', 'drive-settings']);
    },
    JOURNEY_SAVE_TIMEOUT_MS,
  );

  it('keeps two different journeys that share a name apart', async () => {
    await drive('drive-close-an-issue', opened);
    // Its own control, not `opened[1]` spread over it (whose args name `issue-close`, making it a
    // shorter drive of the same journey rather than a different one).
    await drive('drive-close-an-issue', [click('bulk-close', { page: '/issues/7' })]);
    const names = await store.list();
    expect(names).toHaveLength(2);
    const prints = await Promise.all(names.map(async (n) => journeyFingerprint(await load(n))));
    expect(new Set(prints).size).toBe(2);
  });

  /*
   * From two persona drives: "drive-api-login" and "drive-api-login-34636c" sat side by side in the
   * git-tracked folder and on the dashboard. The second drive was the same login with a step more
   * (a retry); one journey is one file, holding the fuller drive.
   */
  it('keeps one file when a drive of the same name repeats or extends the steps it holds', async () => {
    await drive('drive-close-an-issue', opened);
    const retried = [opened[0], opened[0], opened[1]].filter(
      (step): step is RecordedStep => step !== undefined,
    );
    await drive('drive-close-an-issue', retried);
    expect(await store.list()).toEqual(['drive-close-an-issue']);
    expect((await load('drive-close-an-issue')).steps).toHaveLength(3);
    // A shorter drive of it adds nothing beside the fuller one.
    await drive('drive-close-an-issue', [click('issue-close', opened[1])]);
    expect(await store.list()).toEqual(['drive-close-an-issue']);
    expect((await load('drive-close-an-issue')).steps).toHaveLength(3);
  });

  // Never merged or removed, and never copied either: a drive of the journey it already holds adds
  // no automatic twin beside it (one journey listed as three flows, from a persona drive).
  it('never merges, removes or duplicates a hand-named flow', async () => {
    await store.save({ name: 'checkout', version: 1, steps: opened, startPath: '/issues' });
    const before = await store.load('checkout');
    await drive('drive-close-an-issue', opened);
    expect(await store.list()).toEqual(['checkout']);
    expect(await store.load('checkout')).toEqual(before);
  });
});

describe('the recorder knows where a step ended', () => {
  it('fills the page a step led to once it settled, and never overwrites it', () => {
    const tape = new RecordingStore();
    tape.start('r', 0);
    tape.capture(click('a', { page: '/a' }));
    tape.markEnded('/b');
    tape.markEnded('/c');
    const steps = tape.stop('r')?.steps ?? [];
    expect(steps[0]?.endPage).toBe('/b');
  });

  it('falls back to where the next step began when nothing marked it', () => {
    const tape = new RecordingStore();
    tape.start('r', 0);
    tape.capture(click('a', { page: '/a' }));
    tape.capture(click('b', { page: '/b' }));
    expect(tape.stop('r')?.steps[0]?.endPage).toBe('/b');
  });
});

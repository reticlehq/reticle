import { removeTempDir } from '../../machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../project/fs/fs-port.js';
import {
  AppRuntime,
  ReticleVerificationRunSchema,
  Verified,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { AmbientStore } from './ambient-store.js';
import { makeSessionEnd, type SessionEndTarget } from './session-end.js';
import { DEFAULT_SESSION_RETENTION } from './on-disk/retention.js';
import { reticleDirPaths, sessionDirPath } from '../project/dir/reticle-dir.js';

function fakeSession(
  id: string,
  ambient: Record<string, number>,
  onFlush?: () => void,
): SessionEndTarget {
  return {
    id,
    flushJournal: () => {
      onFlush?.();
      return Promise.resolve();
    },
    ambientCounts: () => ambient,
    // What teardown persists. The fakes model a session with no seeded history, so own === total.
    ownAmbientCounts: () => ambient,
  };
}

describe('makeSessionEnd (teardown: flush journal + persist ambient)', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-sessend-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('flushes the journal so the tail of a session is never lost from disk', async () => {
    let flushed = false;
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
    await end(fakeSession('s1', {}, () => (flushed = true)));
    expect(flushed).toBe(true);
  });

  it('persists the learned ambient map so the NEXT session starts warm', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
    await end(fakeSession('s1', { 'chat-log': 12 }));
    expect(await new AmbientStore(fs, root).load()).toEqual({ 'chat-log': 12 });
  });

  it('accumulates across sessions rather than overwriting (the map sharpens over time)', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
    await end(fakeSession('s1', { 'chat-log': 12, ticker: 3 }));
    await end(fakeSession('s2', { 'chat-log': 8 }));
    expect(await new AmbientStore(fs, root).load()).toEqual({ 'chat-log': 20, ticker: 3 });
  });

  it('is a no-op when journaling/persistence is disabled (opt-out)', async () => {
    let flushed = false;
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: false });
    await end(fakeSession('s1', { 'chat-log': 5 }, () => (flushed = true)));
    expect(flushed).toBe(false);
    expect(await new AmbientStore(fs, root).load()).toEqual({});
  });

  it('never throws at teardown even when the flush fails (the tab is already gone)', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
    const broken: SessionEndTarget = {
      id: 's1',
      flushJournal: () => Promise.reject(new Error('disk gone')),
      ambientCounts: () => ({ 'chat-log': 4 }),
      ownAmbientCounts: () => ({ 'chat-log': 4 }),
    };
    await expect(end(broken)).resolves.toBeUndefined();
    // ambient still persisted despite the flush failure
    expect(await new AmbientStore(fs, root).load()).toEqual({ 'chat-log': 4 });
  });
});

/**
 * A BOUND, not a measurement — and the heaviest IO loop of the set, which is why it is surprising it
 * was not on the original list. The test below creates `DEFAULT_SESSION_RETENTION + 5` session
 * directories and writes a file into each, sequentially, through the real filesystem. That is more
 * per-iteration IO than the 40-record loop in `project-tools.test.ts` that actually timed out at
 * vitest's 5 s default on Windows CI.
 */
const SESSION_RETENTION_TIMEOUT_MS = 30_000;

describe('journal retention is bounded on a long-running daemon', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-retain-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'prunes at session END, not only at daemon start',
    async () => {
      // The leak this closes: pruneSessions ran once during wiring, so a daemon that stays up — the
      // normal case, and the entire point of the pool — accumulated a session directory per tab
      // forever. Session end is the right moment: it is exactly when a new directory was just created.
      const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
      const overBound = DEFAULT_SESSION_RETENTION + 5;
      for (let i = 0; i < overBound; i++) {
        const dir = sessionDirPath(root, `s${i}`);
        await fs.mkdir(dir);
        await fs.writeFile(join(dir, 'events.jsonl'), '{}\n');
      }
      expect((await fs.readdir(reticleDirPaths(root).sessions)).length).toBe(overBound);

      await end(fakeSession('s-last', { 'chat-log': 1 }));

      const remaining = await fs.readdir(reticleDirPaths(root).sessions);
      expect(remaining.length).toBeLessThanOrEqual(DEFAULT_SESSION_RETENTION);
    },
    SESSION_RETENTION_TIMEOUT_MS,
  );
});

/**
 * Teardown is where a drive becomes an artifact the platform can see.
 *
 * From a field session: a long run of verdicts driven live, `lastPushAt: null`, an empty
 * dashboard. Nothing
 * was broken — `.reticle/runs/` had one writer, the flow-replay path, so driving the app produced no
 * run and the sync daemon correctly had nothing to send.
 */
describe('the run a drive leaves behind', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-driverun-'));
    root = join(dir, '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  const driven = (verdicts: readonly Verified[]): SessionEndTarget => ({
    ...fakeSession('s-driven', {}),
    projectId: 'acme-web-1234abcd',
    artifactRoot: root,
    readJournalActions: () =>
      Promise.resolve(
        verdicts.map((verified, i) => ({
          v: 1 as const,
          actionId: `c${String(i)}`,
          tool: 'reticle_act_and_wait',
          args: {},
          effect: { claim: `claim ${String(i)}`, verified },
          tRange: { from: 0, to: i },
          at: i,
        })),
      ),
  });

  const runsWritten = async (): Promise<string[]> => {
    try {
      return await fs.readdir(reticleDirPaths(root).runs);
    } catch {
      return [];
    }
  };

  it('writes a run artifact for a session that proved something', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end(driven([Verified.YES, Verified.NO]));
    const files = await runsWritten();
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('writes a run when every verdict was undetermined, because that is worth seeing', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end(driven([Verified.UNKNOWN, Verified.NO_FAULT]));
    expect((await runsWritten()).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('writes nothing for a session that never verified anything', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end(driven([]));
    expect((await runsWritten()).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('writes ONE run across reloads, not one per socket close', async () => {
    // Teardown fires on every socket close, and a reconnecting tab keeps its id and goes on
    // appending to the same journal. Without a stable run id this published a row per reload, each
    // a superset of the last, so one drive read as several overlapping verifications.
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end(driven([Verified.YES]));
    await end(driven([Verified.YES, Verified.NO]));
    expect((await runsWritten()).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  /** The run just written, parsed back off disk, which is the only place worth reading it. */
  const runOnDisk = async (): Promise<ReticleVerificationRun> => {
    const dir = reticleDirPaths(root).runs;
    const file = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))[0] ?? '';
    return ReticleVerificationRunSchema.parse(JSON.parse(await fs.readFile(join(dir, file))));
  };

  it("names the subject in the protocol's terms, including a desktop shell", async () => {
    // The artifact recorded the project, the agent and the trigger, and never what KIND of thing
    // was on the other end -- a run against a Tauri app and one against a web page read the same.
    // Pinned on DISK rather than on the builder, because the schema is what a reader parses and
    // an optional field that never gets written is indistinguishable from one nobody added.
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end({
      ...driven([Verified.YES]),
      url: 'tauri://localhost/checkout',
      runtime: AppRuntime.TAURI,
      currentDocumentId: 'doc_44',
      currentEditEpoch: 9,
    });
    expect((await runOnDisk()).subject).toEqual({
      surface: 'desktop',
      instance: 'doc_44',
      epoch: 9,
      locator: 'tauri://localhost/checkout',
    });
  });

  it('leaves the subject absent when the session could not say where it was', async () => {
    // Absent rather than invented. A subject with no locator is a guess, and a reader cannot tell
    // a guess from a fact once it is in the file.
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 });
    await end(driven([Verified.YES]));
    expect((await runOnDisk()).subject).toBeUndefined();
  });

  it('leaves teardown intact for a session that cannot answer — every existing double', async () => {
    const end = makeSessionEnd({ fs, reticleRoot: root, enabled: true });
    let flushed = false;
    await end(fakeSession('s-plain', {}, () => (flushed = true)));
    expect(flushed).toBe(true);
    expect((await runsWritten()).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

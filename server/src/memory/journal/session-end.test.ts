import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import {
  asProjectId,
  AppRuntime,
  ReticleVerificationRunSchema,
  Verified,
  type ReticleVerificationRun,
  asSessionId,
} from '@reticlehq/core';
import { AmbientStore } from './ambient-store.js';
import { makeSessionEnd, type SessionEndTarget } from './session-end.js';
import { DEFAULT_DIFF_RETENTION, DEFAULT_SESSION_RETENTION } from './on-disk/retention.js';
import { reticleDirPaths, sessionDirPath } from '@/memory/project/dir/reticle-dir.js';

function fakeSession(
  id: string,
  ambient: Record<string, number>,
  onFlush?: () => void,
  artifactRoot?: string,
): SessionEndTarget {
  return {
    id,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
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
        const dir = sessionDirPath(root, asSessionId(`s${i}`));
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
    projectId: asProjectId('acme-web-1234abcd'),
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

/**
 * Every tier the session wrote into is swept, at the root the SESSION used.
 *
 * `pruneSessions` was already scoped to `session.artifactRoot`, with the reason written beside it:
 * "Pruning the daemon's tree instead meant a per-project workspace was never swept at all, so the
 * one place journals really accumulate was the one place retention never ran." Visual diffs and
 * feedback copies were left behind on that move — they are pruned only at daemon START, against the
 * DAEMON's root, which for a globally-registered daemon is `$HOME` and not the project at all.
 *
 * So the two tiers that only ever grow in a project workspace were the two that never got swept
 * there. Same defect as the one already fixed above, in the same file, one line apart.
 *
 * The byte budget rides along for the same reason: it was wired at daemon start in the same change
 * that introduced it, which is the daemon's tree — not the per-project one where the bytes are.
 */
describe('teardown sweeps the tiers at the SESSION root, not the daemon root', () => {
  let daemonRoot: string;
  let projectRoot: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-roots-'));
    daemonRoot = join(dir, 'daemon', '.reticle');
    projectRoot = join(dir, 'project', '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(daemonRoot, '..', '..'));
  });

  it(
    'prunes visual diffs in the project workspace the session actually wrote to',
    async () => {
      const diffs = join(projectRoot, 'visual');
      await fs.mkdir(diffs);
      for (let i = 0; i < DEFAULT_DIFF_RETENTION + 4; i++) {
        await fs.writeFile(join(diffs, `shot-${String(i)}.diff.png`), 'x');
      }
      const before = (await fs.readdir(diffs)).length;

      const end = makeSessionEnd({ fs, reticleRoot: daemonRoot, enabled: true });
      await end(fakeSession('s-last', {}, undefined, projectRoot));

      const after = (await fs.readdir(diffs)).length;
      expect(after).toBeLessThan(before);
      expect(after).toBeLessThanOrEqual(DEFAULT_DIFF_RETENTION);
    },
    SESSION_RETENTION_TIMEOUT_MS,
  );

  it(
    'leaves the daemon root alone when the session wrote elsewhere',
    async () => {
      const daemonDiffs = join(daemonRoot, 'visual');
      await fs.mkdir(daemonDiffs);
      for (let i = 0; i < DEFAULT_DIFF_RETENTION + 4; i++) {
        await fs.writeFile(join(daemonDiffs, `shot-${String(i)}.diff.png`), 'x');
      }
      const before = (await fs.readdir(daemonDiffs)).length;

      const end = makeSessionEnd({ fs, reticleRoot: daemonRoot, enabled: true });
      await end(fakeSession('s-last', {}, undefined, projectRoot));

      // Teardown is about the session's own workspace. The daemon's tree is swept at daemon start.
      expect((await fs.readdir(daemonDiffs)).length).toBe(before);
    },
    SESSION_RETENTION_TIMEOUT_MS,
  );
});

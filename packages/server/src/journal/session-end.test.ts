import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../project/fs-port.js';
import { AmbientStore } from './ambient-store.js';
import { makeSessionEnd, type SessionEndTarget } from './session-end.js';
import { DEFAULT_SESSION_RETENTION } from './retention.js';
import { reticleDirPaths, sessionDirPath } from '../project/reticle-dir.js';

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

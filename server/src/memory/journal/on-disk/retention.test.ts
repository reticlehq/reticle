import { removeTempDir } from '../../../machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '../../project/fs/fs-port.js';
import { pruneFeedback, pruneSessions, pruneVisualDiffs, selectPrunable } from './retention.js';
import { visualDiffPath, visualDir, visualPath } from '../../project/dir/reticle-dir.js';

describe('selectPrunable', () => {
  it('removes the oldest dirs beyond the retention count', () => {
    const dirs = [
      { name: 'old', mtimeMs: 100 },
      { name: 'mid', mtimeMs: 200 },
      { name: 'new', mtimeMs: 300 },
    ];
    expect(selectPrunable(dirs, 2)).toEqual(['old']);
    expect(selectPrunable(dirs, 1)).toEqual(['old', 'mid']);
  });

  it('prunes nothing when at or under the cap', () => {
    expect(selectPrunable([{ name: 'a', mtimeMs: 1 }], 20)).toEqual([]);
  });
});

/**
 * A BOUND, not a measurement: nothing below claims the code is fast.
 *
 * The test that follows creates directories and writes files sequentially through the real
 * filesystem inside a loop, and sleeps 5 ms per iteration on purpose to stagger mtimes. That is
 * milliseconds on macOS and Linux and much slower on a Windows runner, so vitest's 5 s default is a
 * statement about the machine — the exact shape CLAUDE.md forbids asserting on. A generous ceiling
 * cannot make a broken test pass; the `['s2', 's3']` assertion still has to hold.
 */
const SESSION_PRUNE_TIMEOUT_MS = 30_000;

describe('pruneSessions', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-retention-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it(
    'keeps only the retention-most-recent session dirs on disk',
    async () => {
      const sessions = join(root, 'sessions');
      for (const name of ['s1', 's2', 's3']) {
        await mkdir(join(sessions, name), { recursive: true });
        await writeFile(join(sessions, name, 'events.jsonl'), '', 'utf8');
        // stagger mtimes so ordering is deterministic
        await new Promise((r) => setTimeout(r, 5));
      }
      await pruneSessions(fs, root, 2);
      const remaining = (await readdir(sessions)).sort();
      expect(remaining).toEqual(['s2', 's3']);
    },
    SESSION_PRUNE_TIMEOUT_MS,
  );

  it('never throws when there is no sessions dir', async () => {
    await expect(pruneSessions(fs, root, 2)).resolves.toBeUndefined();
  });
});

/**
 * `.reticle/visual/` was 10 MB of a 15 MB workspace and had no delete path at all — no prune, no
 * retention, nothing. Roughly half of it is `.diff.png`, which nothing ever reads back: the diff is
 * written, its path is handed to the caller, and a human either opens it in the next minute or
 * never. It is derived from a baseline and a screenshot, both of which outlive it.
 *
 * So diffs get a cap and baselines do not. A baseline is the reference a comparison MEANS something
 * against; deleting one to save disk turns the next run's verdict into "baseline-missing", which is
 * a worse outcome than a large directory.
 */
describe('the visual diffs nothing reads back', () => {
  let vroot: string;
  let vfs: FileSystemPort;

  beforeEach(async () => {
    vroot = join(await mkdtemp(join(tmpdir(), 'reticle-visual-')), '.reticle');
    vfs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(vroot, '..'));
  });

  /** Writes a baseline and a diff per name, oldest first, so recency is decidable. */
  async function withDiffs(names: readonly string[], retention?: number): Promise<string[]> {
    await mkdir(visualDir(vroot), { recursive: true });
    for (const [i, name] of names.entries()) {
      await writeFile(visualPath(vroot, name), Buffer.from([1]));
      await writeFile(visualDiffPath(vroot, name), Buffer.from([1]));
      const when = new Date(1_700_000_000_000 + i * 1000);
      utimesSync(visualDiffPath(vroot, name), when, when);
    }
    await pruneVisualDiffs(vfs, vroot, retention);
    return (await readdir(visualDir(vroot))).sort();
  }

  it('keeps the baselines whatever it does to the diffs', async () => {
    const left = await withDiffs(['a', 'b', 'c'], 1);
    expect(left.filter((n) => !n.endsWith('.diff.png'))).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('drops the oldest diffs past the cap', async () => {
    const left = await withDiffs(['a', 'b', 'c'], 1);
    expect(left.filter((n) => n.endsWith('.diff.png'))).toEqual(['c.diff.png']);
  });

  it('keeps everything when the cap is not reached', async () => {
    const left = await withDiffs(['a', 'b'], 5);
    expect(left.filter((n) => n.endsWith('.diff.png'))).toEqual(['a.diff.png', 'b.diff.png']);
  });

  it('never throws when there is no visual directory at all', async () => {
    await expect(pruneVisualDiffs(vfs, vroot)).resolves.toBeUndefined();
  });
});

/**
 * `.reticle/feedback/` is a write-only local copy of reports that were already sent.
 *
 * Nothing ever reads the directory back — there is no readdir, no prune, no consumer. It exists so
 * that a report refused delivery is not lost, and the receipt hands the human a path to run. That
 * makes the RECENT ones valuable and the rest dead weight: hundreds of copies of things the outbox
 * already carries.
 *
 * The cap lives here rather than in the writer, which another agent owns. A retention rule about a
 * directory is the same kind of rule whether the directory holds journals, diffs or reports.
 */
describe('the feedback copies nothing reads back', () => {
  let froot: string;
  let ffs: FileSystemPort;

  beforeEach(async () => {
    froot = join(await mkdtemp(join(tmpdir(), 'reticle-feedback-')), '.reticle');
    ffs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(froot, '..'));
  });

  async function withReports(count: number, retention?: number): Promise<string[]> {
    const dir = join(froot, 'feedback');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const path = join(dir, `report-${String(i)}.md`);
      await writeFile(path, 'x');
      const when = new Date(1_700_000_000_000 + i * 1000);
      utimesSync(path, when, when);
    }
    await pruneFeedback(ffs, froot, retention);
    return (await readdir(dir)).sort();
  }

  it('keeps only the most recent reports', async () => {
    expect(await withReports(4, 2)).toEqual(['report-2.md', 'report-3.md']);
  });

  it('keeps everything under the cap', async () => {
    expect(await withReports(2, 5)).toEqual(['report-0.md', 'report-1.md']);
  });

  it('never throws when no report was ever written', async () => {
    await expect(pruneFeedback(ffs, froot)).resolves.toBeUndefined();
  });
});

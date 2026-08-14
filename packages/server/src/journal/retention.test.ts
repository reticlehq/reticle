import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { pruneSessions, selectPrunable } from './retention.js';

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

  it('keeps only the retention-most-recent session dirs on disk', async () => {
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
  });

  it('never throws when there is no sessions dir', async () => {
    await expect(pruneSessions(fs, root, 2)).resolves.toBeUndefined();
  });
});

import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { AmbientStore } from './ambient-store.js';

describe('AmbientStore', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-ambient-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('returns an empty map when nothing is persisted', async () => {
    expect(await new AmbientStore(fs, root).load()).toEqual({});
  });

  it('round-trips the ambient counts', async () => {
    const store = new AmbientStore(fs, root);
    await store.save({ ticker: 42, chat: 100 });
    expect(await store.load()).toEqual({ ticker: 42, chat: 100 });
  });

  it('degrades to empty on a malformed or wrong-version file', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ambient.json'), '{ nope', 'utf8');
    expect(await new AmbientStore(fs, root).load()).toEqual({});
    await writeFile(
      join(root, 'ambient.json'),
      JSON.stringify({ version: 9, regions: {} }),
      'utf8',
    );
    expect(await new AmbientStore(fs, root).load()).toEqual({});
  });
});

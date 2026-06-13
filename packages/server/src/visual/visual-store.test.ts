import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisualStore } from './visual-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 250, 0, 128]);

describe('VisualStore — temp dir, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: VisualStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-visual-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
    store = new VisualStore(fs, root);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('1: saveBaseline → readBaseline round-trips the exact bytes', async () => {
    const path = await store.saveBaseline('home', PNG_BYTES);
    expect(path.endsWith(join('.iris', 'visual', 'home.png'))).toBe(true);
    const back = await store.readBaseline('home');
    expect(back).toEqual(PNG_BYTES);
    // bytes really hit disk (not a string round-trip)
    expect(new Uint8Array(await readFile(path))).toEqual(PNG_BYTES);
  });

  it('2: hasBaseline reflects existence', async () => {
    expect(await store.hasBaseline('home')).toBe(false);
    await store.saveBaseline('home', PNG_BYTES);
    expect(await store.hasBaseline('home')).toBe(true);
  });

  it('3: readBaseline on a missing name returns undefined (no throw)', async () => {
    expect(await store.readBaseline('nope')).toBeUndefined();
  });

  it('4: saveDiff writes to <name>.diff.png', async () => {
    const path = await store.saveDiff('home', PNG_BYTES);
    expect(path.endsWith(join('.iris', 'visual', 'home.diff.png'))).toBe(true);
    expect(new Uint8Array(await readFile(path))).toEqual(PNG_BYTES);
  });

  it('5: an invalid (traversal) name is rejected before any disk write', async () => {
    await expect(store.saveBaseline('../escape', PNG_BYTES)).rejects.toThrow();
    expect(await store.readBaseline('../escape')).toBeUndefined();
    expect(await store.hasBaseline('../escape')).toBe(false);
  });
});

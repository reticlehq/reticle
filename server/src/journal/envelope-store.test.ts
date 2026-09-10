import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { addSegmentToEnvelope, emptyEnvelope } from './envelope.js';
import { EnvelopeStore } from './envelope-store.js';
import type { SegmentRollup } from './rollups.js';

function seg(route: string, durationMs: number): SegmentRollup {
  return {
    route,
    from: 0,
    to: durationMs,
    durationMs,
    actions: 1,
    net: { total: 2, errors: 0 },
    consoleErrors: 0,
    statePathsChanged: [],
  };
}

describe('EnvelopeStore', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-env-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('returns an empty map when nothing is persisted (never throws)', async () => {
    expect((await new EnvelopeStore(fs, root).load()).size).toBe(0);
  });

  it('round-trips envelopes across save/load', async () => {
    const store = new EnvelopeStore(fs, root);
    let env = emptyEnvelope('/checkout');
    for (const d of [100, 110, 95]) env = addSegmentToEnvelope(env, seg('/checkout', d));
    await store.save(new Map([['/checkout', env]]));

    const loaded = await store.load();
    expect(loaded.get('/checkout')?.samples).toBe(3);
    expect(loaded.get('/checkout')?.stats.durationMs.count).toBe(3);
  });

  it('degrades to an empty map on a malformed file', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'envelopes.json'), '{ not json', 'utf8');
    expect((await new EnvelopeStore(fs, root).load()).size).toBe(0);
  });

  it('degrades to an empty map on a wrong schema version', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'envelopes.json'),
      JSON.stringify({ version: 99, routes: {} }),
      'utf8',
    );
    expect((await new EnvelopeStore(fs, root).load()).size).toBe(0);
  });
});

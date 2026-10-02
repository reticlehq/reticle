import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectReadError, RunKind } from '@reticlehq/core';
import { ProjectStore } from './project-store.js';
import { createNodeFileSystem } from './fs/fs-port.js';

/**
 * A file written by a version we do not understand is not corrupt, and must not be treated as if it
 * were.
 *
 * Recording a run repairs a broken history rather than refusing to work: a truncated write on one
 * machine should not stop somebody using Reticle, and there is nothing to lose that was not already
 * lost. That is right, and it stays.
 *
 * A version bump is a different event wearing the same clothes. It makes every file on every machine
 * unreadable at the same moment, and each of those files is perfectly intact. Repairing them means
 * overwriting real history that the next release could have read. The user upgrades, records one
 * run, and everything before it is gone -- and nothing failed, so nobody looks.
 *
 * So: unreadable is repaired, and unrecognised is refused.
 */

async function storeWith(contents: string): Promise<{ store: ProjectStore; path: string }> {
  const root = join(await mkdtemp(join(tmpdir(), 'reticle-project-')), '.reticle');
  await mkdir(root, { recursive: true });
  const path = join(root, 'project.json');
  await writeFile(path, contents, 'utf8');
  return {
    store: new ProjectStore(createNodeFileSystem(), root, { now: () => 1_700_000_000_000 }),
    path,
  };
}

const aRun = { name: 'checkout', kind: RunKind.MANUAL, passed: true } as never;

describe('a project file from another version is refused, not emptied', () => {
  it('reading one says the version is the problem, not the syntax', async () => {
    // Told apart from malformed on purpose: the two need opposite handling, and one message for both
    // would send somebody looking for a typo in a file that has none.
    const { store } = await storeWith(JSON.stringify({ version: 99, runs: [] }));
    const read = await store.read();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe(ProjectReadError.WRONG_VERSION);
  });

  it('recording a run does NOT overwrite it', async () => {
    // The whole point. This is the moment a user's history would disappear.
    const future = JSON.stringify({ version: 99, runs: [{ name: 'kept', at: 1 }] });
    const { store, path } = await storeWith(future);
    await expect(store.recordRun(aRun)).rejects.toThrow(/version/i);
    expect(await readFile(path, 'utf8')).toBe(future);
  });

  it('a genuinely broken file is still repaired, because nothing there can be saved', async () => {
    const { store, path } = await storeWith('{ this is not json');
    await store.recordRun(aRun);
    const after = JSON.parse(await readFile(path, 'utf8')) as { runs: unknown[] };
    expect(after.runs).toHaveLength(1);
  });

  it('a missing file is still created', async () => {
    const { store, path } = await storeWith('{"version":1,"runs":[]}');
    await store.recordRun(aRun);
    const after = JSON.parse(await readFile(path, 'utf8')) as { runs: unknown[] };
    expect(after.runs).toHaveLength(1);
  });
});

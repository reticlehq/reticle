/**
 * A drive whose run record failed to save says so in the daemon log.
 *
 * Teardown swallows the failure on purpose (the tab is already gone and nothing can be retried),
 * and for a long time it swallowed it silently: a drive that left no run left no reason either,
 * which is the "a drive produces no run" class with nothing to look at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, Verified } from '@reticlehq/core';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { makeSessionEnd, type SessionEndTarget } from './session-end.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('@/log.js', () => ({ log: (event: string) => logged.push(event) }));

describe('session teardown logs a run record it could not save', () => {
  let root: string;

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'reticle-endlog-')), '.reticle');
    logged.length = 0;
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('names the failure instead of dropping it', async () => {
    const real = createNodeFileSystem();
    const runs = reticleDirPaths(root).runs;
    const refuse = (path: string): boolean => path.startsWith(runs);
    const fs: FileSystemPort = {
      ...real,
      writeFile: (path, data) =>
        refuse(path) ? Promise.reject(new Error('disk full')) : real.writeFile(path, data),
      rename: (from, to) =>
        refuse(to) ? Promise.reject(new Error('disk full')) : real.rename(from, to),
    };
    const session: SessionEndTarget = {
      id: 's-driven',
      projectId: asProjectId('acme-web-1234abcd'),
      artifactRoot: root,
      flushJournal: () => Promise.resolve(),
      ambientCounts: () => ({}),
      ownAmbientCounts: () => ({}),
      readJournalActions: () =>
        Promise.resolve([
          {
            v: 1 as const,
            actionId: 'c0',
            tool: 'reticle_act_and_wait',
            args: {},
            effect: { claim: 'signed in', verified: Verified.YES },
            tRange: { from: 0, to: 1 },
            at: 1,
          },
        ]),
    };
    await makeSessionEnd({ fs, reticleRoot: root, enabled: true, now: () => 1_700_000 })(session);
    expect(logged).toContain('reticle_drive_run_record_failed');
  });
});

import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { createMemoryFs } from '../memory-fs.js';
import { ensureReticleDir, reticleDirPaths } from './reticle-dir.js';

/**
 * `.reticle/baselines/` was created on every install and could never contain anything.
 *
 * `BaselineStore` is a `Map` that lives and dies with the daemon: nothing serializes a baseline,
 * and `baselinePath()` has no caller outside its own test. Meanwhile the header Reticle writes into
 * a user's `.reticle/.gitignore` names `baselines/` among the directories "meant to be committed",
 * so every install advertised a shareable artifact store that is structurally empty.
 *
 * An empty directory is cheap; a promise about it is not. Somebody reading that header reasonably
 * concludes baselines survive a restart, and the first thing that tells them otherwise is a lost
 * baseline. So the directory goes, and the header stops naming it.
 *
 * The constant and `baselinePath()` stay: both are exported from the package, and removing a public
 * name to tidy an empty folder is a breaking change for a cosmetic gain. If baselines ever do
 * persist, the path helper is already correct.
 */
describe('the directory nothing could write to', () => {
  it('is not created', async () => {
    const { fs } = createMemoryFs();
    const root = '/repo/app/.reticle';
    await ensureReticleDir(fs, root);
    // Vacuity: the ones that ARE used must still be there, or this passes on a broken mkdir.
    expect(await fs.exists(reticleDirPaths(root).root)).toBe(true);
    expect(await fs.exists(reticleDirPaths(root).flows)).toBe(true);
    expect(await fs.exists(reticleDirPaths(root).baselines)).toBe(false);
  });

  it('is not advertised as shareable to the user', async () => {
    const { fs } = createMemoryFs();
    const root = '/repo/app/.reticle';
    const { ensureWorkspaceGitignore } =
      await import('../../journal/on-disk/workspace-gitignore.js');
    await ensureWorkspaceGitignore(fs, root);
    const written = await fs.readFile(`${root}/.gitignore`);
    expect(written).not.toContain(ReticleDir.BASELINES_SUBDIR);
    // Still naming the ones that genuinely are shareable, so this is not passing on an empty file.
    expect(written).toContain(ReticleDir.FLOWS_SUBDIR);
  });
});

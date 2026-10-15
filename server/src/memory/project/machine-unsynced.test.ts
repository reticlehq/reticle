import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_REGISTRY_FILE, ReticleDir } from '@reticlehq/core';
import { emptyProjectRegistry, rememberProject } from '@reticlehq/core/artifacts';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { machineUnsyncedRoots } from './sync-status.js';

/*
 * Persona drive: `reticle sync` sent two flows with the key from the environment, then printed
 * "2 flow(s) in this folder are not on your dashboard: run `reticle connect`". A folder with no
 * link file still sends when the environment holds a key, so it is not one nothing will send.
 */
describe('a folder that sends with the key from the environment', () => {
  const regPath = join(homedir(), ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
  afterEach(() => {
    writeFileSync(regPath, JSON.stringify(emptyProjectRegistry()));
  });

  it('is not told to run reticle connect for flows it sends', async () => {
    const app = mkdtempSync(join(tmpdir(), 'reticle-env-sync-'));
    mkdirSync(join(app, ReticleDir.ROOT, ReticleDir.FLOWS_SUBDIR), { recursive: true });
    writeFileSync(
      join(app, ReticleDir.ROOT, ReticleDir.FLOWS_SUBDIR, 'checkout.json'),
      JSON.stringify({ version: 1, name: 'checkout', steps: [] }),
    );
    writeFileSync(join(app, '.reticle.json'), JSON.stringify({ projectId: 'shop-1' }));
    mkdirSync(join(homedir(), ReticleDir.ROOT), { recursive: true });
    writeFileSync(
      regPath,
      JSON.stringify(rememberProject(emptyProjectRegistry(), 'shop-1', app, 1)),
    );

    const env = { RETICLE_CLOUD_URL: 'https://cloud.test', RETICLE_CLOUD_KEY: 'rk_live_env' };
    const roots = await machineUnsyncedRoots(createNodeFileSystem(), homedir(), env);
    const mine = roots.find((r) => r.root === join(app, ReticleDir.ROOT));
    expect(mine === undefined || (mine.linked && 0 === mine.flows)).toBe(true);
  });
});

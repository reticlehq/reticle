import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleEnv } from '@reticlehq/core';
import { resolveBridgeSecurityWithAutoToken } from './bridge-security.js';

describe('resolveBridgeSecurityWithAutoToken', () => {
  const previousAllow = process.env[ReticleEnv.ALLOW_INSECURE];
  let dir: string | undefined;

  afterEach(async () => {
    if (previousAllow === undefined) delete process.env[ReticleEnv.ALLOW_INSECURE];
    else process.env[ReticleEnv.ALLOW_INSECURE] = previousAllow;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('provisions a token into a writable pairing dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-pair-'));
    const security = await resolveBridgeSecurityWithAutoToken({ pairingTokenDir: dir });
    expect(security.token).toBeTruthy();
  });

  it('refuses to start tokenless when provision fails', async () => {
    // A path that cannot be created as a directory (file-as-parent).
    dir = await mkdtemp(join(tmpdir(), 'reticle-pair-'));
    const blocked = join(dir, 'not-a-dir');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(blocked, 'x');
    await expect(
      resolveBridgeSecurityWithAutoToken({ pairingTokenDir: join(blocked, 'child') }),
    ).rejects.toThrow(/refusing to start without auth/);
  });

  it('allows tokenless only when RETICLE_ALLOW_INSECURE is set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-pair-'));
    const blocked = join(dir, 'not-a-dir');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(blocked, 'x');
    process.env[ReticleEnv.ALLOW_INSECURE] = '1';
    const security = await resolveBridgeSecurityWithAutoToken({
      pairingTokenDir: join(blocked, 'child'),
    });
    expect(security.token).toBeUndefined();
  });
});

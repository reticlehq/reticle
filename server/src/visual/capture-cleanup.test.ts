import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETICLE_CAPTURE_FILE_PREFIX } from '@reticlehq/core';
import { start } from '../index.js';
import { cleanupCaptureDirectories, trackCaptureDirectory } from './capture-cleanup.js';

const made = new Set<string>();

async function privateCaptureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), RETICLE_CAPTURE_FILE_PREFIX));
  made.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...made].map((dir) => rm(dir, { recursive: true, force: true })));
  made.clear();
  await cleanupCaptureDirectories();
});

describe('private capture directory shutdown cleanup', () => {
  it('removes the empty directory after its consumed capture has been unlinked', async () => {
    const dir = await privateCaptureDir();
    const capture = join(dir, `${RETICLE_CAPTURE_FILE_PREFIX}1.png`);
    await writeFile(capture, 'png');
    trackCaptureDirectory(capture);
    await rm(capture);

    await cleanupCaptureDirectories();

    await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    made.delete(dir);
  });

  it('refuses to recursively remove a directory with an unexpected file', async () => {
    const dir = await privateCaptureDir();
    const capture = join(dir, `${RETICLE_CAPTURE_FILE_PREFIX}1.png`);
    await writeFile(join(dir, 'unexpected.txt'), 'keep');
    trackCaptureDirectory(capture);

    await cleanupCaptureDirectories();

    await expect(access(join(dir, 'unexpected.txt'))).resolves.toBeUndefined();
  });

  it('runs from the server close path used by the desktop harness', async () => {
    const dir = await privateCaptureDir();
    const capture = join(dir, `${RETICLE_CAPTURE_FILE_PREFIX}1.png`);
    trackCaptureDirectory(capture);
    const server = await start({ port: 0, mcp: false });

    await server.close();

    await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    made.delete(dir);
  });
});

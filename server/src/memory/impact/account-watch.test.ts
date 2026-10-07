import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchAccountFiles, type AccountFilesWatch } from './account-watch.js';

const FAST_MS = 20;
let watch: AccountFilesWatch | undefined;
afterEach(() => watch?.close());

const changed = (path: string): Promise<void> =>
  new Promise((resolve) => {
    watch = watchAccountFiles(resolve, FAST_MS);
    watch.watch(path);
  });

describe('the HUD hears sign-in and link changes made in another terminal', () => {
  it('fires when a file that did not exist is written, as `reticle link` does', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'acct-watch-')), 'cloud.json');
    const heard = changed(path);
    writeFileSync(path, '{}');
    await expect(heard).resolves.toBeUndefined();
  });

  it('fires when a file is removed, as `reticle logout` does', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'acct-watch-')), 'session.json');
    writeFileSync(path, '{"token":"t"}');
    const heard = changed(path);
    rmSync(path);
    await expect(heard).resolves.toBeUndefined();
  });
});

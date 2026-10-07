import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchAccountFiles, type AccountFilesWatch } from './account-watch.js';

const FAST_MS = 20;
let watch: AccountFilesWatch | undefined;
afterEach(() => watch?.close());

/**
 * Resolves on the first change after the watcher took its baseline. `watchFile` stats the file
 * asynchronously, so a write issued straight after `watch` could land before that first stat and
 * become the baseline itself: under load the test then waited for a change that had already
 * happened. The daemon never races it, since a `reticle link` comes long after the watch started.
 */
const changed = async (path: string): Promise<{ heard: Promise<void> }> => {
  const heard = new Promise<void>((resolve) => {
    watch = watchAccountFiles(resolve, FAST_MS);
    watch.watch(path);
  });
  await new Promise((r) => setTimeout(r, FAST_MS * 10));
  return { heard };
};

describe('the HUD hears sign-in and link changes made in another terminal', () => {
  it('fires when a file that did not exist is written, as `reticle link` does', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'acct-watch-')), 'cloud.json');
    const { heard } = await changed(path);
    writeFileSync(path, '{}');
    await expect(heard).resolves.toBeUndefined();
  });

  it('fires when a file is removed, as `reticle logout` does', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'acct-watch-')), 'session.json');
    writeFileSync(path, '{"token":"t"}');
    const { heard } = await changed(path);
    rmSync(path);
    await expect(heard).resolves.toBeUndefined();
  });
});

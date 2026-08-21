import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeStorageProfileStore } from './storage-profile.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reticle-storage-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NodeStorageProfileStore', () => {
  it('publishes a project-scoped profile atomically with owner-only permissions', async () => {
    const root = await tempRoot();
    const store = new NodeStorageProfileStore(root);

    await store.save('project-a', 'lease-a', async (path) => {
      await writeFile(path, '{"cookies":[]}');
    });

    const path = await store.loadPath('project-a');
    expect(path).toBeDefined();
    expect(await readFile(path ?? '', 'utf8')).toBe('{"cookies":[]}');
    if ('win32' !== process.platform) {
      expect((await stat(path ?? '')).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
    await expect(readdir(root)).resolves.toHaveLength(1);
  });

  it('hashes project ids so an untrusted id cannot escape the profile directory', async () => {
    const root = await tempRoot();
    const store = new NodeStorageProfileStore(root);

    await store.save('../../outside', 'lease-a', async (path) => {
      await writeFile(path, '{}');
    });

    const path = await store.loadPath('../../outside');
    expect(path?.startsWith(`${root}/`)).toBe(true);
    expect(path).not.toContain('..');
  });

  it('keeps projects isolated and resets only the requested profile', async () => {
    const root = await tempRoot();
    const store = new NodeStorageProfileStore(root);
    const write =
      (value: string) =>
      async (path: string): Promise<void> => {
        await writeFile(path, value);
      };
    await store.save('project-a', 'lease-a', write('a'));
    await store.save('project-b', 'lease-b', write('b'));

    await expect(store.reset('project-a')).resolves.toBe(true);
    await expect(store.loadPath('project-a')).resolves.toBeUndefined();
    const projectB = await store.loadPath('project-b');
    expect(await readFile(projectB ?? '', 'utf8')).toBe('b');
    await expect(store.reset('project-a')).resolves.toBe(false);
  });

  it('removes a failed temporary write without replacing the last good profile', async () => {
    const root = await tempRoot();
    const store = new NodeStorageProfileStore(root);
    await store.save('project-a', 'lease-a', async (path) => {
      await writeFile(path, 'good');
    });

    await expect(
      store.save('project-a', 'lease-b', async (path) => {
        await writeFile(path, 'partial');
        throw new Error('capture failed');
      }),
    ).rejects.toThrow('capture failed');

    const path = await store.loadPath('project-a');
    expect(await readFile(path ?? '', 'utf8')).toBe('good');
    await expect(readdir(root)).resolves.toHaveLength(1);
  });
});

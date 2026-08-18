import { describe, expect, it } from 'vitest';
import { readEverConnected, writeEverConnected } from './session-history.js';
import type { FileSystemPort } from '../project/fs-port.js';

function memoryFs(files: Record<string, string> = {}): FileSystemPort {
  return {
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(value);
    },
    writeFile: (path, data) => {
      files[path] = data;
      return Promise.resolve();
    },
    appendFile: () => Promise.resolve(),
    readFileBytes: () => Promise.resolve(new Uint8Array()),
    writeFileBytes: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    exists: (path) => Promise.resolve(files[path] !== undefined),
    readdir: () => Promise.resolve([]),
    rename: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    stat: () => Promise.resolve({ mtimeMs: 0 }),
    isNotFound: (error) => 'ENOENT' === (error as { code?: string }).code,
  };
}

describe('session history', () => {
  it('starts false when no marker exists', async () => {
    expect(await readEverConnected(memoryFs(), '/project/.reticle')).toBe(false);
  });

  it('round-trips the fact that a session was served', async () => {
    const files: Record<string, string> = {};
    const fs = memoryFs(files);
    await writeEverConnected(fs, '/project/.reticle');
    expect(await readEverConnected(fs, '/project/.reticle')).toBe(true);
  });

  it('ignores malformed or unrelated markers', async () => {
    const fs = memoryFs({ '/project/.reticle/session-history.json': '{"everConnected":false}' });
    expect(await readEverConnected(fs, '/project/.reticle')).toBe(false);
  });
});

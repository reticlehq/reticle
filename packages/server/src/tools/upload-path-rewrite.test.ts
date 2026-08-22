/**
 * Unit tests for `rewriteUploadArgs` — the daemon-side path that lets an agent name a file on
 * disk and have its real bytes reach the browser's `<input type="file">`.
 *
 * These tests use an in-memory FileSystemPort fake so no actual disk files are needed.
 */
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { rewriteUploadArgs } from './real-input-attempt.js';
import type { ToolDeps } from './tools.js';
import type { FileSystemPort } from '../project/fs-port.js';

/** Build a minimal FileSystemPort fake backed by an in-memory map of path → bytes. */
function fakeFs(files: Record<string, Uint8Array>): FileSystemPort {
  return {
    readFile: () => Promise.resolve(''),
    writeFile: () => Promise.resolve(),
    appendFile: () => Promise.resolve(),
    readFileBytes: (path) => {
      const bytes = files[path];
      if (bytes === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(bytes);
    },
    writeFileBytes: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    exists: (path) => Promise.resolve(path in files),
    readdir: () => Promise.resolve([]),
    rename: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    stat: (path) => {
      if (!(path in files)) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve({ mtimeMs: Date.now() });
    },
    isNotFound: (err) => String(err).includes('ENOENT'),
  };
}

/** Minimal ToolDeps with only the fields rewriteUploadArgs needs. */
function fakeDeps(files: Record<string, Uint8Array>, cwd = '/project'): ToolDeps {
  return {
    fs: fakeFs(files),
    // reticleRoot is cwd/.reticle — rewriteUploadArgs derives cwd from join(reticleRoot, '..')
    reticleRoot: `${cwd}/.reticle`,
  } as unknown as ToolDeps;
}

const HELLO_BYTES = new TextEncoder().encode('hello world');

describe('rewriteUploadArgs', () => {
  describe('passthrough for non-upload actions', () => {
    it('returns args unchanged when action is not upload', async () => {
      const inner = { value: 'hello' };
      const result = await rewriteUploadArgs(
        fakeDeps({}),
        ActionType.FILL,
        inner,
      );
      expect(result).toBe(inner); // same reference — no copy made
    });

    it('returns args unchanged when action is upload but no path is given', async () => {
      const inner = { content: 'abc', name: 'file.txt', type: 'text/plain' };
      const result = await rewriteUploadArgs(
        fakeDeps({}),
        ActionType.UPLOAD,
        inner,
      );
      expect(result).toBe(inner);
    });
  });

  describe('happy path — absolute path within cwd', () => {
    it('reads the file and rewrites to { content, name, type }', async () => {
      const deps = fakeDeps({ '/project/fixtures/doc.pdf': HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: '/project/fixtures/doc.pdf',
      });

      expect(result['content']).toBe(Buffer.from(HELLO_BYTES).toString('base64'));
      expect(result['name']).toBe('doc.pdf');
      expect(result['type']).toBe('application/pdf');
      expect(result['path']).toBeUndefined(); // stripped — browser doesn't understand it
    });

    it('uses a relative path resolved against cwd', async () => {
      const deps = fakeDeps({ '/project/fixtures/data.csv': HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: 'fixtures/data.csv',
      });

      expect(result['name']).toBe('data.csv');
      expect(result['type']).toBe('text/csv');
      expect(result['content']).toBe(Buffer.from(HELLO_BYTES).toString('base64'));
    });
  });

  describe('caller overrides', () => {
    it('respects caller-supplied name and type', async () => {
      const deps = fakeDeps({ '/project/file.bin': HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: '/project/file.bin',
        name: 'my-upload.txt',
        type: 'text/plain',
      });

      expect(result['name']).toBe('my-upload.txt');
      expect(result['type']).toBe('text/plain');
    });

    it('passes through unrecognised keys alongside the rewritten fields', async () => {
      const deps = fakeDeps({ '/project/file.txt': HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: '/project/file.txt',
        confirmDangerous: true,
      });

      // confirmDangerous is a generic action arg — it should survive
      expect(result['confirmDangerous']).toBe(true);
      expect(result['content']).toBeDefined();
    });
  });

  describe('MIME inference', () => {
    const cases: Array<[string, string]> = [
      ['report.pdf', 'application/pdf'],
      ['data.csv', 'text/csv'],
      ['notes.txt', 'text/plain'],
      ['config.json', 'application/json'],
      ['photo.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['archive.zip', 'application/zip'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['unknown.bin', 'application/octet-stream'],
    ];

    for (const [filename, expectedMime] of cases) {
      it(`infers ${expectedMime} for ${filename}`, async () => {
        const deps = fakeDeps({ [`/project/${filename}`]: HELLO_BYTES });
        const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
          path: `/project/${filename}`,
        });
        expect(result['type']).toBe(expectedMime);
      });
    }
  });

  describe('trust boundary — path must be within cwd', () => {
    it('refuses an absolute path outside cwd', async () => {
      const deps = fakeDeps({});
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '/etc/passwd' }),
      ).rejects.toThrow('outside the project root');
    });

    it('refuses a relative path that escapes cwd via ../', async () => {
      const deps = fakeDeps({});
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '../../../etc/passwd' }),
      ).rejects.toThrow('outside the project root');
    });

    it('names the project root in the error so the agent knows the allowed scope', async () => {
      const deps = fakeDeps({});
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '/etc/passwd' }),
      ).rejects.toThrow('/project'); // names the root
    });

    it('permits a path exactly at cwd (edge case)', async () => {
      // A path that resolves to a file AT the cwd root, not below it — should be fine.
      const deps = fakeDeps({ '/project/root-file.txt': HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: '/project/root-file.txt',
      });
      expect(result['content']).toBeDefined();
    });
  });

  describe('missing or unreadable file', () => {
    it('throws a clear error when the file does not exist', async () => {
      const deps = fakeDeps({}); // no files registered
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '/project/missing.pdf' }),
      ).rejects.toThrow('could not be read');
    });
  });

  describe('size cap', () => {
    it('refuses a file that exceeds the 10 MiB limit', async () => {
      const bigFile = new Uint8Array(11 * 1024 * 1024); // 11 MiB
      const deps = fakeDeps({ '/project/huge.pdf': bigFile });
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '/project/huge.pdf' }),
      ).rejects.toThrow('exceeds the');
    });

    it('accepts a file at exactly the limit', async () => {
      const exactFile = new Uint8Array(10 * 1024 * 1024); // 10 MiB exactly
      const deps = fakeDeps({ '/project/exact.pdf': exactFile });
      // Should not throw — just check it resolves without error
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: '/project/exact.pdf' }),
      ).resolves.toBeDefined();
    });
  });
});

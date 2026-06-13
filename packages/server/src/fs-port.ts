import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

/**
 * The injectable filesystem seam. Server logic depends on this interface, never on node:fs
 * directly — so tests pass an in-memory or temp-dir adapter and never touch the repo's .iris/.
 */
export interface FileSystemPort {
  /** Read a UTF-8 file. Rejects (ENOENT) if absent. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  /** Recursive + idempotent: no throw if the directory already exists. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** List entries of a directory (for flows/baselines listing). */
  readdir(path: string): Promise<string[]>;
  /** ENOENT classifier — narrows unknown without `any`, so callers can distinguish missing-file. */
  isNotFound(error: unknown): boolean;
}

/** Production adapter — the single import site of node:fs/promises in the server. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (path) => readdir(path),
    isNotFound: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  };
}

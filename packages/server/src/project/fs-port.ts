import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

/**
 * The injectable filesystem seam. Server logic depends on this interface, never on node:fs
 * directly — so tests pass an in-memory or temp-dir adapter and never touch the repo's .iris/.
 */
export interface FileSystemPort {
  /** Read a UTF-8 file. Rejects (ENOENT) if absent. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  /** Read raw bytes (PNG baselines). Rejects (ENOENT) if absent. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Write raw bytes (PNG screenshots/diffs). */
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  /** Recursive + idempotent: no throw if the directory already exists. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** List entries of a directory (for flows/baselines listing). */
  readdir(path: string): Promise<string[]>;
  /** Atomically replace `to` with `from` (same-FS rename) — for crash-safe writes. */
  rename(from: string, to: string): Promise<void>;
  /** Idempotent remove (no throw if absent) — for retention pruning + cleaning temp files. */
  rm(path: string): Promise<void>;
  /** ENOENT classifier — narrows unknown without `any`, so callers can distinguish missing-file. */
  isNotFound(error: unknown): boolean;
}

/** Production adapter — the single import site of node:fs/promises in the server. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    readFileBytes: async (path) => {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    writeFileBytes: (path, data) => writeFile(path, data),
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
    rename: (from, to) => rename(from, to),
    rm: async (path) => {
      await rm(path, { force: true });
    },
    isNotFound: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  };
}

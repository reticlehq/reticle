import { dirname } from 'node:path';
import { writeFileAtomic } from '@/memory/project/fs/write-atomic.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { AmbientFileSchema } from './on-disk/ambient-file.js';
import { onlyStableAmbient, type AmbientCounts } from '@reticlehq/engine/window/ambient.js';

/** Bumped on any breaking change to the persisted ambient-map shape. */
const AMBIENT_FILE_VERSION = 1;

/**
 * Persists the learned ambient-churn region map at `.reticle/ambient.json`. Local, single-project
 * memory (stays OSS — OSS-VS-SERVER). Loads never throw: missing/malformed/wrong-version degrades to
 * an empty map, so a bad file never breaks a drive — the layer just re-learns the ambient regions.
 */
export class AmbientStore {
  readonly #fs: FileSystemPort;
  readonly #path: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#path = reticleDirPaths(root).ambient;
  }

  async load(): Promise<AmbientCounts> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    const result = AmbientFileSchema.safeParse(parsed);
    // Ref-keyed entries are dropped on the way IN as well as out: a file written before this rule
    // existed is full of them, and seeding a session with another session's ref numbering is the
    // defect itself. An older file therefore degrades to its stable entries rather than misfiring.
    return result.success ? onlyStableAmbient(result.data.regions) : {};
  }

  async save(counts: AmbientCounts): Promise<void> {
    await this.#fs.mkdir(dirname(this.#path));
    // Only what means anything in the next session. A ref is an address within ONE session's
    // numbering, so persisting it teaches the next session to suppress an element it never saw.
    const regions = onlyStableAmbient(counts);
    const body = `${JSON.stringify({ version: AMBIENT_FILE_VERSION, regions }, null, 2)}\n`;
    await writeFileAtomic(this.#fs, this.#path, body);
  }
}

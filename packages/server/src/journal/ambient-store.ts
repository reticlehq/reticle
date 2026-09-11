import { dirname } from 'node:path';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';
import { AmbientFileSchema, type AmbientCounts } from './ambient.js';

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
    return result.success ? result.data.regions : {};
  }

  async save(counts: AmbientCounts): Promise<void> {
    await this.#fs.mkdir(dirname(this.#path));
    const body = `${JSON.stringify({ version: AMBIENT_FILE_VERSION, regions: counts }, null, 2)}\n`;
    const tmp = `${this.#path}.tmp`;
    await this.#fs.writeFile(tmp, body);
    await this.#fs.rename(tmp, this.#path);
  }
}

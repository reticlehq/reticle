import type { FileSystemPort } from '../project/fs-port.js';
import {
  reticleDirPaths,
  isValidFlowName,
  visualDiffPath,
  visualPath,
} from '../project/reticle-dir.js';

/**
 * On-disk PNG baselines + diffs under .reticle/visual/. Binary sibling of FlowStore — same
 * name guard (rejects path traversal before any join) and injected FileSystemPort, but bytes not text.
 */
export class VisualStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#root = root;
  }

  /** The absolute baseline path for `name` (for echoing back to the agent). Guards the name so a
   *  crafted value can never echo a path outside .reticle/visual/ to a future caller that does IO. */
  baselinePath(name: string): string {
    if (!isValidFlowName(name)) throw new Error(`invalid visual baseline name: ${name}`);
    return visualPath(this.#root, name);
  }

  /** The absolute overlay-diff path for `name`. Same name guard as baselinePath. */
  diffPath(name: string): string {
    if (!isValidFlowName(name)) throw new Error(`invalid visual diff name: ${name}`);
    return visualDiffPath(this.#root, name);
  }

  /** True iff a valid name and a baseline PNG exists on disk. */
  async hasBaseline(name: string): Promise<boolean> {
    if (!isValidFlowName(name)) return false;
    return this.#fs.exists(visualPath(this.#root, name));
  }

  /** Write a PNG baseline (auto-creating .reticle/visual/). Returns its path; throws on a bad name. */
  async saveBaseline(name: string, png: Uint8Array): Promise<string> {
    if (!isValidFlowName(name)) throw new Error(`invalid visual baseline name: ${name}`);
    await this.#fs.mkdir(reticleDirPaths(this.#root).visual);
    const path = visualPath(this.#root, name);
    await this.#fs.writeFileBytes(path, png);
    return path;
  }

  /** Read a PNG baseline, or undefined if absent / invalid name (never throws on missing). */
  async readBaseline(name: string): Promise<Uint8Array | undefined> {
    if (!isValidFlowName(name) || !(await this.#fs.exists(visualPath(this.#root, name)))) {
      return undefined;
    }
    try {
      return await this.#fs.readFileBytes(visualPath(this.#root, name));
    } catch (error) {
      if (this.#fs.isNotFound(error)) return undefined; // exists/read TOCTOU race
      throw error;
    }
  }

  /** Write the overlay diff PNG for `name` (auto-creating .reticle/visual/). Returns its path. */
  async saveDiff(name: string, png: Uint8Array): Promise<string> {
    if (!isValidFlowName(name)) throw new Error(`invalid visual baseline name: ${name}`);
    await this.#fs.mkdir(reticleDirPaths(this.#root).visual);
    const path = visualDiffPath(this.#root, name);
    await this.#fs.writeFileBytes(path, png);
    return path;
  }
}

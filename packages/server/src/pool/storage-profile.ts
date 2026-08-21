/**
 * Owner-only Playwright storage profiles for pooled browser leases.
 *
 * A profile contains live cookies and local storage, so it is treated as a credential: project ids
 * are hashed before becoming path segments, the directory/file modes are tightened on every write,
 * and a failed capture never replaces the last known-good profile.
 */

import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PROFILE_EXT = '.json';
const TEMP_EXT = '.tmp';
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export interface StorageProfileStore {
  loadPath(projectId: string): Promise<string | undefined>;
  save(projectId: string, leaseId: string, capture: (path: string) => Promise<void>): Promise<void>;
  reset(projectId: string): Promise<boolean>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Filesystem-backed profile store rooted outside the project checkout (normally ~/.reticle). */
export class NodeStorageProfileStore implements StorageProfileStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #profilePath(projectId: string): string {
    return join(this.#root, `${digest(projectId)}${PROFILE_EXT}`);
  }

  async loadPath(projectId: string): Promise<string | undefined> {
    const path = this.#profilePath(projectId);
    return (await exists(path)) ? path : undefined;
  }

  async save(
    projectId: string,
    leaseId: string,
    capture: (path: string) => Promise<void>,
  ): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    await chmod(this.#root, OWNER_DIRECTORY_MODE);
    const path = this.#profilePath(projectId);
    const tempPath = join(this.#root, `${digest(projectId)}-${digest(leaseId)}${TEMP_EXT}`);
    try {
      await capture(tempPath);
      await chmod(tempPath, OWNER_FILE_MODE);
      await rename(tempPath, path);
      await chmod(path, OWNER_FILE_MODE);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async reset(projectId: string): Promise<boolean> {
    const path = this.#profilePath(projectId);
    if (!(await exists(path))) return false;
    await rm(path, { force: true });
    return true;
  }
}

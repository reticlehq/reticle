/**
 * The project memory store for ONE artifact root.
 *
 * `deps.project` is bound to the daemon's own root at construction, which is right only when the
 * daemon happens to have been started inside the app it is driving — and a user-scoped MCP
 * registration, the common case, starts it wherever the editor's cwd is. So every run record, every
 * learned route and every observability high-water mark was written into that directory: a
 * `.reticle/` appearing in a backend nobody instrumented, and a driven project whose own memory
 * stayed empty. The cloud half of `recordReplayRun` had already been moved onto the session's root
 * and its local half left behind, which is how a replay outcome could reach the dashboard and not
 * the project it belonged to.
 *
 * Reads and writes both go through here, deliberately: a write that resolves to the app while a
 * read still answers from the daemon's directory is worse than either alone — the record lands and
 * is then invisible to the tool that exists to report it.
 *
 * Rebinding is cheap (a filesystem port, a root and a clock) and the single-project case allocates
 * nothing: when the resolved root IS the daemon's, `deps.project` comes back unchanged.
 */
import { ProjectStore } from './project-store.js';
import type { FileSystemPort } from './fs/fs-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

export function projectForRoot(deps: ToolDeps, root: string): ProjectStore {
  if (root === deps.reticleRoot) return deps.project;
  return new ProjectStore(deps.fs, root, { now: deps.now });
}

/**
 * The same question asked by the daemon rather than by a tool: one store per artifact root, so a
 * session's learned routes land in the app that was driven and not in whatever directory the daemon
 * was launched from. The daemon's own store is seeded in, so the single-project case allocates
 * nothing and keeps the instance every other caller already holds.
 */
export function projectStoreResolver(
  fs: FileSystemPort,
  daemonStore: ProjectStore,
  daemonRoot: string,
  now: () => number,
): (root: string | undefined) => ProjectStore {
  const byRoot = new Map<string, ProjectStore>([[daemonRoot, daemonStore]]);
  return (root) => {
    const key = root ?? daemonRoot;
    let found = byRoot.get(key);
    if (found === undefined) {
      found = new ProjectStore(fs, key, { now });
      byRoot.set(key, found);
    }
    return found;
  };
}

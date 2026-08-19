/**
 * Where the project's `.reticle.json` actually is, rather than where the daemon happens to stand.
 *
 * The daemon's working directory is an artifact of how the editor launched it. Cursor and friends
 * start MCP servers from the user's home directory as often as not, so "no `.reticle.json` in the
 * cwd" is a fact about our process, not about the user's project. A monorepo makes that obvious —
 * the config sits under `apps/web` while the daemon stands at `C:\Users\<user>` — but it is equally
 * true of any editor that does not chdir first.
 *
 * So: walk up to the repo root, then look in the conventional workspace locations under it. Report
 * every config found rather than silently picking one, and report where we looked when there are
 * none. An agent can choose between two candidates; it cannot choose from a message that says none
 * exist.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Directories under the repo root that conventionally hold workspace packages. */
const WORKSPACE_DIRS = ['apps', 'packages'] as const;

/** Stop the upward walk here. Guards against runaway loops on a detached or unusual filesystem. */
const MAX_WALK_DEPTH = 40;

export interface ConfigDiscovery {
  /** Repo root, identified by a `.git` entry. Undefined when the walk found none. */
  repoRoot?: string | undefined;
  /** Every `.reticle.json` found, absolute, in discovery order. Empty when there are none. */
  configs: readonly string[];
  /** Directories actually examined, absolute — what the message means by "where we looked". */
  searched: readonly string[];
}

/** Is there a `.git` here? Works for both a real repo and a worktree/submodule file. */
function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * Walk up from `start` looking for a `.git`. Returns undefined rather than guessing when the walk
 * reaches the filesystem root — a home directory with no repo in it is a real case, and pretending
 * the root is a project would make the search below scan the user's entire home.
 */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Immediate subdirectories of `dir`, or nothing if it is absent or unreadable. */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((entry) => join(dir, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Find every `.reticle.json` reachable from `start`: the cwd itself, each directory up to and
 * including the repo root, then one level inside each conventional workspace directory under that
 * root.
 *
 * Never throws. An unreadable directory is skipped rather than failing the whole search — this runs
 * to build an error message, and a diagnostic that can itself fail is worse than a vague one.
 */
export function discoverConfigs(start: string): ConfigDiscovery {
  const searched: string[] = [];
  const configs: string[] = [];
  const seen = new Set<string>();

  const look = (dir: string): void => {
    const absolute = resolve(dir);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    searched.push(absolute);
    const candidate = join(absolute, '.reticle.json');
    if (existsSync(candidate)) configs.push(candidate);
  };

  let dir = resolve(start);
  const repoRoot = findRepoRoot(dir);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    look(dir);
    if (dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (undefined !== repoRoot) {
    for (const workspace of WORKSPACE_DIRS) {
      for (const packageDir of subdirectories(join(repoRoot, workspace))) look(packageDir);
    }
  }

  return { repoRoot, configs, searched };
}

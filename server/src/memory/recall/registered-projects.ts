import { existsSync, readFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import {
  PROJECT_REGISTRY_FILE,
  ReticleDir,
  parseProjectRegistry,
  projectCandidates,
} from '@reticlehq/core';

/** One project this machine has paired before, in the shape the no-session facts already carry. */
export interface RegisteredProject {
  directory: string;
  projectId?: string;
}

/**
 * Projects this machine has paired before, read from `~/.reticle/projects.json`.
 *
 * The no-session diagnosis learns where projects are by WALKING: up from the daemon's cwd, then
 * across the declared workspaces of whatever repo root it lands in. That walk is the right first
 * answer and it has one blind spot, which happens to be the most reported install problem we have.
 *
 * Several IDEs register the MCP server GLOBALLY, so the daemon starts with a cwd of `/` or `$HOME`.
 * From there the walk finds nothing — there is nothing above `/`, and no repo root at either — so
 * `configsElsewhere` comes back empty and the diagnosis falls through to the branches that reason
 * from "no config anywhere", whose advice is `reticle init`. Reported six separate times, on a
 * project that was already correctly instrumented; one reporter burned a turn re-running `init` over
 * a working config while `doctor`, run from the app directory, said `project ✓ wired here`.
 *
 * The registry is the evidence the walk cannot reach: every project that has ever paired with this
 * machine is in it, with its directory. A daemon that cannot SEE a project can still KNOW of it, and
 * "I am standing in the wrong place" is a completely different diagnosis from "you never installed
 * this" — opposite fixes, and we were giving the second one.
 *
 * Read fresh rather than cached: a project can pair for the first time while this daemon is up, and
 * a stale empty read would keep the wrong diagnosis for the life of the process. Fails soft to
 * empty, because a diagnosis is the last thing that should throw.
 */
export function registeredProjects(home: string): RegisteredProject[] {
  try {
    const path = join(home, ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
    if (!existsSync(path)) return [];
    const registry = parseProjectRegistry(JSON.parse(readFileSync(path, 'utf8')));
    return projectCandidates(registry).map((candidate) => ({
      directory: candidate.directory,
      projectId: candidate.projectId,
    }));
  } catch {
    return [];
  }
}

/**
 * Is this daemon standing somewhere a project could never live?
 *
 * THE NARROWING THAT MAKES THIS SAFE, and it is not optional. An empty config walk has two causes:
 * the daemon is parked outside every project (the global-registration case this fixes), or it is
 * standing in a real directory that genuinely has not been wired yet (a new project, where
 * `reticle init` is exactly the right advice). Both look identical from the walk.
 *
 * Consulting the registry for BOTH would break the second: any developer machine has registered
 * projects, so a brand-new unwired project would be told "your config is elsewhere, restart the
 * daemon there" instead of "run init". That trades the reported false negative for an unreported
 * one, on the more common path — a bad trade, and caught here by two existing tests going red.
 *
 * The filesystem root and the user's home directory are the discriminator. Neither is ever an app
 * directory, and both are exactly where an IDE's global MCP registration starts a daemon. Anywhere
 * else, an empty walk still means what it always meant.
 */
export function isUnscopedRoot(directory: string, home: string): boolean {
  const at = resolve(directory);
  return at === resolve(home) || at === parse(at).root;
}

/**
 * The registered projects that are NOT the directory this daemon is standing in.
 *
 * Same rule the config walk applies: a project at the daemon's own cwd is not "elsewhere", and
 * reporting it as such would tell a correctly-scoped daemon to go and look somewhere else.
 */
export function registeredElsewhere(home: string, directory: string): RegisteredProject[] {
  if (!isUnscopedRoot(directory, home)) return [];
  return registeredProjects(home).filter((project) => project.directory !== directory);
}

/**
 * Which `.reticle` a connected session's artifacts belong in — the IO half.
 *
 * `resolveArtifactRoot` and `unmatchedRoot` next door are pure on purpose; this is the file that
 * goes to disk for them: the user-level project registry, config discovery, and the one question
 * that decides whether the daemon may write into its own working directory at all.
 *
 * It lives here rather than in the daemon bootstrap because it is a subject, not wiring — and
 * because the bootstrap is at its line cap, which is the cohesion signal that rule doing its job.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  PROJECT_REGISTRY_FILE,
  emptyProjectRegistry,
  parseProjectRegistry,
} from '@reticlehq/core/artifacts';
import { ReticleDir } from '@reticlehq/core';
import {
  discoverProjectConfigs,
  hasProjectConfig,
  type ConfigDiscovery,
} from '@/command/cli/config/config-discovery.js';
import { log } from '@/log.js';
import {
  ArtifactRootReason,
  projectCandidatesFrom,
  resolveArtifactRoot,
  unmatchedRoot,
  type ArtifactRoot,
} from './artifact-root.js';

/**
 * Is the daemon's own directory a Reticle project, or is it a guest there?
 *
 * Answered ONCE per resolver rather than per session: a directory does not become a project between
 * two tabs connecting, and this is the IO half `unmatchedRoot` deliberately does not do.
 */
function daemonSitsInAProject(daemonRoot: string): boolean {
  try {
    // Either mark counts. `.reticle.json` means somebody ran `init` here; an existing `.reticle/`
    // means Reticle has been invited into this tree before, including by a version that predates
    // the config file. A directory with neither has never agreed to hold anybody's session data.
    return existsSync(daemonRoot) || hasProjectConfig(dirname(daemonRoot));
  } catch {
    // Unreadable is not a licence to write. Treat it as somebody else's directory.
    return false;
  }
}

export function artifactRootResolver(
  daemonRoot: string,
): (projectId: string | undefined) => ArtifactRoot {
  const daemonIsProject = daemonSitsInAProject(daemonRoot);
  return (projectId) => {
    let registry = emptyProjectRegistry();
    try {
      const path = join(homedir(), ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
      registry = existsSync(path)
        ? parseProjectRegistry(JSON.parse(readFileSync(path, 'utf8')))
        : registry;
    } catch {
      // A cache that cannot be read is an empty cache, never an error: the daemon still resolves
      // through discovery, and falls back to its own root exactly as it did before this existed.
    }
    let discovery: ConfigDiscovery = { found: [], searched: [] };
    try {
      discovery = discoverProjectConfigs(process.cwd());
    } catch {
      // Same reasoning: a diagnostic search that throws must not take a tool call with it.
    }
    const resolved = resolveArtifactRoot({
      projectId,
      candidates: projectCandidatesFrom(discovery, registry),
      daemonRoot,
    });
    if (resolved.reason === ArtifactRootReason.MATCHED_PROJECT) return resolved;
    // Could not name the project. The old code wrote into the daemon's directory anyway and said
    // nothing, which put `.reticle/` — journals included — into repositories nobody had
    // instrumented. Evidence still has to live somewhere, so it goes to the user's own
    // `~/.reticle/unmatched/<projectId>` instead, and the daemon says so rather than leaving
    // somebody to find the files.
    const root = unmatchedRoot({
      daemonRoot,
      daemonIsProject,
      home: homedir(),
      ...(projectId === undefined ? {} : { projectId }),
    });
    if (root !== daemonRoot) {
      log('artifact_root_unmatched', {
        projectId: projectId ?? null,
        reason: resolved.reason,
        root,
      });
    }
    return { ...resolved, root };
  };
}

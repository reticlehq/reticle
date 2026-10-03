/**
 * Which `.reticle` a connected session's artifacts belong in — the IO half.
 *
 * `resolveArtifactRoot` and `unmatchedRoot` next door are pure on purpose; this is the file that
 * goes to disk for them: the user-level project registry, config discovery, and the one question
 * that decides whether the daemon may write into its own working directory at all.
 *
 * It lives here rather than in the daemon bootstrap because it is a subject, not wiring — and
 * because the bootstrap is at its line cap, which is the cohesion signal that rule doing its job.
 *
 * ## Why `artifactRootResolver` takes a `deps`
 *
 * Both of its IO answers come from the REAL disk and the REAL `process.cwd()`: which projects this
 * machine knows, and whether the daemon's own directory declares one. That left the file untestable
 * at the level where its defect actually lives — the `unmatchedRoot` specs next door hand a
 * `daemonProjectId` straight in, so a mistake in READING it would leave every one of them green
 * while the worktree bug reproduced unchanged. The defaults are the production answers; the seam is
 * what lets a test say "these are the projects on this machine" without one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  PROJECT_REGISTRY_FILE,
  emptyProjectRegistry,
  parseProjectRegistry,
  type ProjectCandidate,
} from '@reticlehq/core/artifacts';
import { type ProjectId, ReticleDir } from '@reticlehq/core';
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

/**
 * The project a candidate list says lives at the daemon's own directory.
 *
 * Not the same question as `daemonSitsInAProject`: that one asks whether the tree invited Reticle in
 * at all (either mark counts, including a bare `.reticle/` from a version that predates the config
 * file), and this one asks WHICH project it is. The difference is the whole of #1244 — a daemon in
 * repo A serving an app from a git worktree B belongs to A and is being asked about B.
 *
 * Takes the candidates rather than gathering them, so the answer is a function of one list and a test
 * can supply it. Read from that same list the resolver already builds, so there is one answer to
 * "where does this project live" rather than a second `.reticle.json` parser here. A daemon whose
 * root was passed explicitly (`--root`, or an embedder's own `reticleRoot`) is not in that list and
 * answers undefined, which is the safe direction: it cannot prove the named project is its own, so it
 * declines the daemon root and the session goes to the unmatched bucket instead.
 */
function daemonOwnProjectId(
  daemonRoot: string,
  candidates: readonly ProjectCandidate[],
): string | undefined {
  const directory = dirname(daemonRoot);
  return candidates.find((candidate) => candidate.directory === directory)?.projectId;
}

/**
 * Every project this machine knows the directory of: discovered `.reticle.json` files first, then
 * the user-level registry. Read on each call, since `init` can run in another terminal while the
 * daemon is up.
 */
function knownProjectCandidates(): ProjectCandidate[] {
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
  return projectCandidatesFrom(discovery, registry);
}

/**
 * The directory of the project a page announced, or undefined when this machine does not know it.
 *
 * A daemon is shared: started from `$HOME`, a monorepo root, or another project's MCP client, its
 * cwd is often not the app that sent the HELLO. The version-skew remedy read `package.json` from
 * cwd anyway, so it fell back to the generic sensor package and told a Next.js project to install
 * `@reticlehq/browser` (#1135). This is the same lookup the artifact root uses, keyed by the page's
 * own project id.
 */
export function projectDirectoryFor(projectId: string | undefined): string | undefined {
  if (projectId === undefined) return undefined;
  const directories = new Set(
    knownProjectCandidates()
      .filter((candidate) => candidate.projectId === projectId)
      .map((candidate) => candidate.directory),
  );
  // Two checkouts declaring one id are refused, as the artifact root refuses them: naming one of
  // them would read the wrong app's package.json and prescribe its packages to the other.
  return 1 === directories.size ? [...directories][0] : undefined;
}

/** Where this resolver gets its two IO answers. The defaults are the production ones. */
export interface ArtifactRootResolverDeps {
  /** Every project this machine knows about. Defaults to discovery + the user registry. */
  candidates?: () => ProjectCandidate[];
  /** Whether the daemon's own directory is a Reticle project. Defaults to looking at disk. */
  daemonIsProject?: (daemonRoot: string) => boolean;
}

export function artifactRootResolver(
  daemonRoot: string,
  deps: ArtifactRootResolverDeps = {},
): (projectId: ProjectId | undefined, origin?: string) => ArtifactRoot {
  const candidates = deps.candidates ?? knownProjectCandidates;
  const sitsInAProject = deps.daemonIsProject ?? daemonSitsInAProject;
  const daemonIsProject = sitsInAProject(daemonRoot);
  // Resolved beside it and ONCE, for the same reason: a directory's `.reticle.json` does not change
  // between two tabs connecting. Only read when the daemon really is in a project, since it is the
  // sole thing that can license a write into the daemon's own tree.
  const daemonProjectId = daemonIsProject
    ? daemonOwnProjectId(daemonRoot, candidates())
    : undefined;
  return (projectId, origin) => {
    const resolved = resolveArtifactRoot({
      projectId,
      candidates: candidates(),
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
      ...(daemonProjectId === undefined ? {} : { daemonProjectId }),
      ...(projectId === undefined ? {} : { projectId }),
      // Only reached when no project id survives the guard. Without it every app that never
      // stamped one shares a single directory -- and that directory holds the durable half, so one
      // app's learned expectations become another's.
      ...(origin === undefined ? {} : { origin }),
    });
    if (root !== daemonRoot) {
      log('artifact_root_unmatched', {
        projectId: projectId ?? null,
        // The other half of the comparison, so a reader can tell "the daemon was a guest" from
        // "the daemon is in a DIFFERENT project" without reading the config files by hand.
        daemonProjectId: daemonProjectId ?? null,
        reason: resolved.reason,
        root,
      });
    }
    return { ...resolved, root };
  };
}

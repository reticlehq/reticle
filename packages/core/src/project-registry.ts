import { z } from 'zod';

/**
 * Which directory a projectId lives in, on this machine.
 *
 * Config discovery answers the same question by walking out from the daemon's own working directory,
 * which is right whenever the daemon and the app share a tree. It cannot answer it at all when they
 * do not — a daemon started in one repo, driving an app in a sibling checkout, will never find that
 * app's `.reticle.json` however far it walks. That is not an edge case: an editor starts a
 * user-scoped MCP server wherever it likes, so it is the default arrangement.
 *
 * `init` holds both halves at the moment it runs — the directory it is initialising and the
 * projectId it has just written into that directory's `.reticle.json`. Recording the pair once makes
 * every later session resolvable from anywhere on the machine.
 *
 * This is a CACHE, not a source of truth. `.reticle.json` on disk remains the authority; an entry
 * here is a hint about where to look. So every operation fails soft: a malformed file is an empty
 * registry, never a throw, because taking a daemon down over a stale cache would trade a small
 * problem for a large one.
 *
 * The contract lives in core for the same reason the daemon registry does — it is shared by a writer
 * (`init`, the CLI) and a reader (the daemon's artifact-root resolution), and a filename or a shape
 * that drifts between the two is a defect neither side can see.
 */

/** Sibling of `daemon-<port>.json` in `~/.reticle`. One file, all projects. */
export const PROJECT_REGISTRY_FILE = 'projects.json';

export const ProjectRegistryEntrySchema = z.object({
  /** Absolute path to the directory whose `.reticle.json` declares this project. */
  directory: z.string().min(1),
  /** When this pairing was last confirmed. Lets a future prune drop entries nobody has opened. */
  lastSeenAt: z.number(),
});
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;

export const ProjectRegistrySchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectRegistryEntrySchema),
});
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

/** A project the resolver may consider. Structurally identical to config discovery's `FoundConfig`
 *  on purpose: both sources feed one code path, so neither becomes the privileged one. */
export interface ProjectCandidate {
  projectId: string;
  directory: string;
}

export function emptyProjectRegistry(): ProjectRegistry {
  return { version: 1, projects: {} };
}

/**
 * Record where a project lives. Pure — returns a new registry, takes its clock as an argument.
 *
 * Keyed on the id, so a project that moved (renamed, re-cloned, moved to another disk) replaces its
 * old path rather than leaving it behind as a competing answer. A second stale answer is exactly
 * what makes the resolver refuse, so letting them accumulate would break resolution for the project
 * that moved most recently — the one most likely to be in use.
 */
export function rememberProject(
  registry: ProjectRegistry,
  projectId: string,
  directory: string,
  now: number,
): ProjectRegistry {
  if (0 === projectId.length || 0 === directory.length) return registry;
  return {
    version: 1,
    projects: { ...registry.projects, [projectId]: { directory, lastSeenAt: now } },
  };
}

/** Every remembered project, in the shape the artifact-root resolver consumes. */
export function projectCandidates(registry: ProjectRegistry): ProjectCandidate[] {
  return Object.entries(registry.projects).map(([projectId, entry]) => ({
    projectId,
    directory: entry.directory,
  }));
}

/** Parse a registry file's contents, failing soft to empty. Never throws. */
export function parseProjectRegistry(raw: unknown): ProjectRegistry {
  const parsed = ProjectRegistrySchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyProjectRegistry();
}

import { join } from 'node:path';
import {
  SAFE_SEGMENT_PATTERN,
  ReticleDir,
  fnv1a,
  projectCandidates,
  type ProjectCandidate,
  type ProjectId,
  type ProjectRegistry,
} from '@reticlehq/core';
import type { ConfigDiscovery } from '@/command/cli/config/config-discovery.js';

/**
 * Which `.reticle/` a session's artifacts belong in.
 *
 * Everything Reticle persists — flows, the capability contract, baselines, capsules, the cross-run
 * project memory — used to resolve against the DAEMON's own `process.cwd()`, which says where the
 * daemon was launched and not which project is being verified. Usually not even the same tree: a
 * user-scoped MCP registration is the common case, and the editor that spawns it starts it wherever
 * it likes. Three shapes of the same defect: `cwd=/` gave `ENOENT: mkdir '/.reticle'`; a daemon
 * started in project A wrote project B's flow into A's checkout and reported success without naming
 * the path; and `verify_change` could only answer "unknown" because no flow could be persisted.
 *
 * Candidates arrive from config discovery (which walks out from the daemon's own directory) and from
 * the user-level project registry (which `init` writes, and which reaches checkouts discovery cannot
 * see). This function does not know which source an entry came from: a privileged source would be a
 * second rule for one question.
 *
 * Matched on `projectId` because HELLO already stamps it and `.reticle.json` already declares it, so
 * the join works for every SDK already in the field. A `root` on HELLO would move the wire contract
 * and strand every older SDK on the fallback.
 *
 * It can DECLINE: every non-matching branch returns the daemon root and says which branch it was. A
 * wrong root writes a caller's evidence into a tree they never drove, so the ambiguous case refuses
 * rather than picks, and the reason travels with the answer.
 */

/** Why the root below is the root. Travels with the answer so a caller can say what happened. */
export const ArtifactRootReason = {
  /** Exactly one discovered config declares this session's project. The good case. */
  MATCHED_PROJECT: 'matched-project',
  /** The session declared no projectId — a pre-2.0 SDK. Nothing to match on. */
  NO_PROJECT_ID: 'no-project-id',
  /** The search ran and nothing it found declares this project. */
  NO_MATCH: 'no-match',
  /** Two or more checkouts declare this project. Refused rather than guessed. */
  AMBIGUOUS: 'ambiguous',
} as const;
export type ArtifactRootReason = (typeof ArtifactRootReason)[keyof typeof ArtifactRootReason];

interface ArtifactRootQuery {
  /** The connected session's HELLO projectId, when it sent one. */
  projectId: ProjectId | undefined;
  /** Every project this machine knows about. Supplied, not gathered here — this stays pure. */
  candidates: readonly ProjectCandidate[];
  /** Where artifacts go when the project cannot be identified. Already a `.reticle` path. */
  daemonRoot: string;
}

export interface ArtifactRoot {
  /** Absolute path to the `.reticle` directory. Always present, on every branch. */
  root: string;
  reason: ArtifactRootReason;
  /**
   * The competing project directories, on `AMBIGUOUS` only. A caller that has to explain the refusal
   * needs to name them; a caller that does not can ignore the field.
   */
  candidates?: string[];
}

/**
 * Resolve the artifact root for one session.
 *
 * Pure: no IO, no cwd, no clock. The filesystem walk belongs to `discoverProjectConfigs` and is
 * passed in, which is what makes every branch below testable without a fixture tree.
 */
export function resolveArtifactRoot(query: ArtifactRootQuery): ArtifactRoot {
  const { projectId, candidates, daemonRoot } = query;

  if (projectId === undefined || 0 === projectId.length) {
    return { root: daemonRoot, reason: ArtifactRootReason.NO_PROJECT_ID };
  }

  const matches = dedupeByDirectory(candidates.filter((c) => c.projectId === projectId));

  if (0 === matches.length) {
    return { root: daemonRoot, reason: ArtifactRootReason.NO_MATCH };
  }

  if (matches.length > 1) {
    return {
      root: daemonRoot,
      reason: ArtifactRootReason.AMBIGUOUS,
      candidates: matches.map((config) => config.directory),
    };
  }

  const [only] = matches;
  // `matches.length === 1` above, so this is defined — but the codebase forbids `!`, and a default
  // that can never be taken is cheaper than the alternative spelling.
  const directory = only?.directory ?? '';
  if (0 === directory.length) {
    return { root: daemonRoot, reason: ArtifactRootReason.NO_MATCH };
  }

  return { root: join(directory, ReticleDir.ROOT), reason: ArtifactRootReason.MATCHED_PROJECT };
}

/**
 * One entry per directory.
 *
 * Discovery and the registry routinely name the SAME checkout — the registry remembers what `init`
 * wrote, and discovery finds that same file whenever the daemon happens to be in the tree. Counting
 * it twice would read as two competing checkouts and make the resolver refuse, which is the one
 * outcome worse than either source alone.
 */
function dedupeByDirectory(matches: readonly ProjectCandidate[]): ProjectCandidate[] {
  const seen = new Set<string>();
  const out: ProjectCandidate[] = [];
  for (const candidate of matches) {
    if (seen.has(candidate.directory)) continue;
    seen.add(candidate.directory);
    out.push(candidate);
  }
  return out;
}

/**
 * Everything this machine knows about where projects live, from both sources.
 *
 * Discovery first, deliberately: it read a `.reticle.json` that exists RIGHT NOW, while the registry
 * is a cache of something `init` saw once. Order only decides which duplicate survives dedupe, and
 * the one confirmed a moment ago is the better survivor.
 */
export function projectCandidatesFrom(
  discovery: ConfigDiscovery,
  registry: ProjectRegistry,
): ProjectCandidate[] {
  const discovered: ProjectCandidate[] = discovery.found.flatMap((config) =>
    config.projectId === undefined || 0 === config.projectId.length
      ? []
      : [{ projectId: config.projectId, directory: config.directory }],
  );
  return [...discovered, ...projectCandidates(registry)];
}

/** Where evidence goes when no project could be named and the daemon is a guest in this tree. */
export const UNMATCHED_SUBDIR = 'unmatched';

/** What a project with NO identity at all is called on disk. Never blank, so the path is always real. */
const UNNAMED_PROJECT = 'unnamed';

/**
 * The bucket for a project that could not name itself but was served from somewhere.
 *
 * `unnamed` used to take every one of these, which made it not a project's directory but the union
 * of every project that ever failed to identify itself — sharing one `project.json`, one
 * `envelopes.json`, one `flake.json` and one `assertion-tiers.json`. Those are the durable half:
 * learned routes, per-route expectations, a quarantine ledger and an anti-downgrade floor. One
 * app's floor silently becoming another app's floor is a wrong answer, not untidy disk.
 *
 * And it is the ORDINARY path, not an edge: a page that never stamped an id is an app instrumented
 * without a build plugin, a page loaded before the plugin ran, or any tree where the daemon is a
 * guest.
 *
 * The origin is the next-best identity available at that moment. It does not pretend to be a
 * project id — two apps served on one port at different times still share a bucket — but that is a
 * far smaller wrong than every unidentified app in the world sharing one.
 */
const ORIGIN_BUCKET_PREFIX = 'origin-';

/**
 * The fallback root for a session whose project could not be resolved.
 *
 * Falling back to the daemon's own root was unconditional and silent, and that is how Reticle came
 * to create `.reticle/` — session journals included, carrying URLs, request and response bodies and
 * page text — in a user's BACKEND directory. Their editor starts the daemon there; the directory
 * was never instrumented and never agreed to hold anybody's session data. They deleted it, and the
 * next session wrote it again.
 *
 * Two cases, and only one of them was ever the intended behaviour:
 *
 *   - the daemon is sitting IN a Reticle project (a developer who ran `reticle serve` in their own
 *     app), and the session is asking about THAT project. Its root is the right answer, and it is
 *     the case the old fallback was written for.
 *   - otherwise — a guest in the tree, or a daemon in its own checkout serving a DIFFERENT project.
 *     Then the evidence goes to the user's own `~/.reticle/unmatched/<projectId>`, which is
 *     Reticle's to write.
 *
 * It is never dropped. A verdict with nowhere to live is a worse failure than one in an unexpected
 * place, and the caller says out loud where it went.
 *
 * ## The second case in that list used to be missing, and it is not an edge case
 *
 * `daemonIsProject` answers "is the daemon sitting in SOME Reticle project". The guard below read it
 * as "this session's project", and those are different questions whenever the two ids differ. Run
 * the daemon in repo A, then connect an app from a git worktree B of that same repo: B has its own
 * `projectId` in its own `.reticle.json`, and discovery cannot see it — it walks out from A's
 * `process.cwd()` and never crosses into a sibling checkout — so this function is reached with a
 * NAMED project and the daemon's root came back anyway. B's intents, flows and runs were written
 * into A's checkout, and the returned path said A, so nothing looked wrong.
 *
 * A real identity always wins. The daemon's root is only the answer when it is that identity's own
 * root, or when no identity was named at all.
 *
 * `projectId` arrives in HELLO from the page, so it is untrusted input on a path join and is held
 * to one safe segment — the same guard session ids and flow names already pass. `daemonProjectId`
 * is read from the daemon's own `.reticle.json` and gets the same treatment, because equality
 * against a guarded value is only as strong as the weaker side.
 */
export function unmatchedRoot(query: {
  daemonRoot: string;
  /** Whether the daemon's own directory is a Reticle project — an IO question, answered by the caller. */
  daemonIsProject: boolean;
  /**
   * The daemon's OWN projectId, when its directory declares one. Absent means the daemon cannot
   * prove which project it belongs to, so a named project that is not demonstrably its own declines.
   *
   * A plain `string` rather than a `ProjectId`, because it arrives from a `ProjectCandidate` — the
   * registry's view of a `.reticle.json` — and the brand is only minted where the id is read out of
   * that file for this daemon. Comparing it against a branded session id is unaffected: the brand is
   * a `string`, and the guard below is what actually holds it to one safe path segment.
   */
  daemonProjectId?: string | undefined;
  /** The user's home directory. Passed in rather than read, so this stays pure. */
  home: string;
  projectId?: ProjectId | undefined;
  /**
   * Where the session was served from, when it is known. Used ONLY when no project id survives the
   * segment guard — a real id always wins, because it is an identity and this is a stand-in.
   */
  origin?: string | undefined;
}): string {
  if (query.daemonIsProject && isTheDaemonsOwnProject(query.daemonProjectId, query.projectId))
    return query.daemonRoot;
  const id = query.projectId ?? '';
  const named = SAFE_SEGMENT_PATTERN.test(id) && !id.includes('..');
  return join(
    query.home,
    ReticleDir.ROOT,
    UNMATCHED_SUBDIR,
    named ? id : unnamedSegment(query.origin),
  );
}

/**
 * May the daemon write this session's artifacts into its own `.reticle/`?
 *
 * Two ways to qualify, and the difference between them is the whole bug: belonging to the directory
 * is not the same as owning it.
 *
 *   - Nobody named a project (a pre-2.0 SDK sends no projectId). There is no identity to disagree
 *     with, and the daemon's own root is the only thing on offer.
 *   - The named project IS the daemon's own, and the daemon can prove it — `.reticle.json` sits in
 *     its directory and declares the same id. Both sides go through the same segment guard, because
 *     an equality between a guarded value and an unguarded one is only as strong as the loose side.
 *
 * A NAMED project the daemon cannot match declines, including when it has a `.reticle/` but no
 * readable id. Declining costs the session its home directory and buys the guarantee that one
 * checkout never receives another's ledger; the alternative is a wrong answer that reports success.
 *
 * The two ids are REQUIRED parameters rather than one object, and that is load-bearing. Taking a
 * partial object let a caller omit a field and still compile — and an omitted `projectId` reads as
 * "nobody named a project", which answers `true` and puts the session straight back into the daemon's
 * checkout. That is the original defect, reachable by a typo rather than by a decision.
 */
function isTheDaemonsOwnProject(
  daemonProjectId: string | undefined,
  projectId: ProjectId | undefined,
): boolean {
  if (projectId === undefined || 0 === projectId.length) return true;
  if (daemonProjectId === undefined || 0 === daemonProjectId.length) return false;
  return (
    daemonProjectId === projectId &&
    SAFE_SEGMENT_PATTERN.test(daemonProjectId) &&
    !daemonProjectId.includes('..')
  );
}

/** Hashed, not spelled: an origin carries a host and a port, and neither belongs in a path segment. */
function unnamedSegment(origin: string | undefined): string {
  if (origin === undefined || 0 === origin.trim().length) return UNNAMED_PROJECT;
  return `${ORIGIN_BUCKET_PREFIX}${fnv1a(origin.trim())}`;
}

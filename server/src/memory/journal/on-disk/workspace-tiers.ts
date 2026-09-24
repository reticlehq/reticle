import { ReticleDir } from '@reticlehq/core';

/**
 * May retention delete this to reclaim disk?
 *
 * MEMORY is why `.reticle/` exists — what a flow replays from, what a deviation is measured
 * against. It is small, it is never evicted, and it must keep being written however full the disk
 * is. EVIDENCE is what one drive left behind: journals, run artifacts, pixel diffs. It is large, it
 * ages out, and losing the oldest of it costs nothing anybody can name.
 */
export const Durability = {
  MEMORY: 'memory',
  EVIDENCE: 'evidence',
} as const;
export type Durability = (typeof Durability)[keyof typeof Durability];

/**
 * Does this belong in the repository, or only on the machine that wrote it?
 *
 * COMMIT is the shareable half: a flow nobody else can replay is not a regression check. LOCAL is
 * per-machine churn, and journals carry URLs, request and response bodies and page text from the
 * app under test, so keeping them out of a shared repository is worth doing on its own account.
 */
export const Sharing = {
  COMMIT: 'commit',
  LOCAL: 'local',
} as const;
export type Sharing = (typeof Sharing)[keyof typeof Sharing];

/** What one `.reticle/` entry is, on both axes at once. */
export interface WorkspaceTier {
  readonly durability: Durability;
  readonly sharing: Sharing;
  /** A directory is ignored as `name/` and swept entry by entry; a file is neither. */
  readonly isDirectory: boolean;
}

const localDir = { durability: Durability.EVIDENCE, sharing: Sharing.LOCAL, isDirectory: true };
const localFile = { durability: Durability.MEMORY, sharing: Sharing.LOCAL, isDirectory: false };
const sharedDir = { durability: Durability.MEMORY, sharing: Sharing.COMMIT, isDirectory: true };
const sharedFile = { durability: Durability.MEMORY, sharing: Sharing.COMMIT, isDirectory: false };

/**
 * Every top-level name `.reticle/` can hold, classified on both axes.
 *
 * One list used to answer both questions with one answer, and they are not the same question.
 * `capsules/` is committed — a fail-to-pass capsule a teammate cannot replay is not a regression
 * check — AND it is evidence a drive left behind, which grows without bound. That cell did not
 * exist, so the byte budget, which read the gitignore's list, structurally could not see capsules
 * however large they got. Splitting the axes is what makes that sayable; it does not by itself say
 * it, and `capsules/` stays MEMORY here until the budget is measured against it.
 *
 * Declaration order is the order the ignore file lists them, so the file a user already has on disk
 * and the one written today are the same file.
 */
export const WORKSPACE_TIERS: Readonly<Record<string, WorkspaceTier>> = {
  [ReticleDir.SESSIONS_SUBDIR]: localDir,
  [ReticleDir.RUNS_SUBDIR]: localDir,
  [ReticleDir.VISUAL_SUBDIR]: localDir,
  // Write-only: a local copy of what was already sent. The outbox is the record.
  [ReticleDir.FEEDBACK_SUBDIR]: localDir,
  [ReticleDir.PROJECT_FILE]: localFile,
  [ReticleDir.AMBIENT_FILE]: localFile,
  [ReticleDir.ENVELOPES_FILE]: localFile,
  [ReticleDir.FLAKE_FILE]: localFile,
  [ReticleDir.TIERS_FILE]: localFile,
  // The user's own record of what Reticle did for them, on THIS machine.
  [ReticleDir.IMPACT_FILE]: localFile,
  // This machine's conversation with the server. Its own doc comment says why committing it is
  // harmful: one machine's pull cursor makes every other machine skip what it has not seen.
  [ReticleDir.CLOUD_STATE_FILE]: localFile,
  // Triage pulled back from the dashboard — a cache of somebody's decisions, re-pullable at will.
  [ReticleDir.ISSUES_FILE]: localFile,
  [ReticleDir.CONTRACT_FILE]: sharedFile,
  [ReticleDir.FLOWS_SUBDIR]: sharedDir,
  [ReticleDir.BASELINES_SUBDIR]: sharedDir,
  [ReticleDir.CAPSULES_SUBDIR]: sharedDir,
  [ReticleDir.INTENT_FILE]: sharedFile,
  // The sharded form of the same ledger, and shared for the same reason.
  [ReticleDir.INTENT_SUBDIR]: sharedDir,
  [ReticleDir.CLOUD_LINK_FILE]: sharedFile,
  // A hook is a decision the whole team shares, exactly like a package script: one that exists only
  // on the machine that wrote it is a rule nobody else is following. It names COMMANDS and never a
  // credential, so it is safe to commit — the same reasoning that puts `cloud.json` here while its
  // API key stays in ~/.reticle.
  [ReticleDir.HOOKS_FILE]: sharedFile,
  // What a drive types into each labelled field. Committed for two reasons: a replay must send
  // exactly what the recording sent or it is not a replay, and a value a model wrote once should be
  // reviewable and editable by the team rather than regenerated differently on every machine.
  [ReticleDir.FILL_VALUES_FILE]: sharedFile,
};

function namesWhere(match: (tier: WorkspaceTier) => boolean): readonly string[] {
  return Object.entries(WORKSPACE_TIERS)
    .filter(([, tier]) => match(tier))
    .map(([name]) => name);
}

/** Machine-local directories, without the trailing slash the ignore file wants. */
export const LOCAL_DIRS: readonly string[] = namesWhere(
  (tier) => Sharing.LOCAL === tier.sharing && tier.isDirectory,
);

/** Machine-local files. */
export const LOCAL_FILES: readonly string[] = namesWhere(
  (tier) => Sharing.LOCAL === tier.sharing && !tier.isDirectory,
);

/** The directories retention sweeps, ignored or not. The byte budget and the count bounds read this. */
export const EVIDENCE_DIRS: readonly string[] = namesWhere(
  (tier) => Durability.EVIDENCE === tier.durability && tier.isDirectory,
);

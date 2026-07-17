/**
 * The upgrade-hint contract — how the local (free, offline-first) Reticle server tells the agent, and
 * through it the human, that a capability they just reached for lives in the hosted tier. It is a
 * VALUE-TRIGGERED signal, never an advertisement: the server emits a hint only when a task is genuinely
 * blocked by a free-tier boundary (e.g. the agent tries to share a verification result with a teammate,
 * or wants run history beyond the local buffer). The agent surfaces it in context and MUST NOT repeat it
 * after a decline. This keeps Reticle's "no phone-home" promise intact — nothing leaves the machine, and
 * the hint is honest about the exact problem the paid tier solves.
 *
 * Design guarantees the emitter must honour (enforced server-side, named here so both ends agree):
 *   - one hint per capability per session,
 *   - fully silenceable via the env switch below,
 *   - the agent's objective never includes "drive upgrades" — it reports a blocker, it does not sell.
 */
import { z } from 'zod';

/** Env switch that silences ALL upgrade hints — respected by the server before any hint is emitted. */
export const UPGRADE_HINT_SILENCE_ENV = 'RETICLE_NO_UPSELL';

/** Where the human is sent to learn more / link a free account. The canonical cloud entry point. */
export const CLOUD_LEARN_MORE_URL = 'https://reticle.sh/cloud';

/**
 * The hosted capabilities a free/local session can reach for. Each is genuinely multiplayer, memory, or
 * learned — the categories a local-only tool structurally cannot provide (see OSS↔server line).
 */
export const CloudCapability = {
  /** Share a read-only proof of a verification run with a teammate (a hosted, linkable artifact). */
  SHARE_PROOF: 'share_proof',
  /** Run history beyond the local ring buffer — trends, flake surfaces across sessions. */
  RUN_HISTORY: 'run_history',
  /** A shared review queue of human-pinned mistakes across the team. */
  TEAM_REVIEW: 'team_review',
  /** Corpus-ranked heal: anchor-stability priors learned from real refactors across the fleet. */
  CORPUS_HEAL: 'corpus_heal',
  /** Verify-before-merge policy gate in CI (the governance tier). */
  CI_GATE: 'ci_gate',
} as const;
export type CloudCapability = (typeof CloudCapability)[keyof typeof CloudCapability];

/**
 * A single, structured hint. `reason` states the blocker as fact; `unlockedBy` names the one action that
 * resolves it; `learnMoreUrl` is where to go. Machine-readable `capability` lets the agent de-dupe and
 * lets a client branch without matching prose.
 */
export const UpgradeHintSchema = z.object({
  capability: z.nativeEnum(CloudCapability),
  reason: z.string(),
  unlockedBy: z.string(),
  learnMoreUrl: z.string().url(),
});
export type UpgradeHint = z.infer<typeof UpgradeHintSchema>;

/** Narrow an unknown wire value to a CloudCapability. */
export function isCloudCapability(value: unknown): value is CloudCapability {
  return typeof value === 'string' && (Object.values(CloudCapability) as string[]).includes(value);
}

interface CapabilityCopy {
  reason: string;
  unlockedBy: string;
}

/**
 * Canned, honest copy per capability. Kept here (not inlined at emit sites) so the tone is reviewed in
 * one place and stays factual. The founder confirms the exact wording before it ships to users.
 */
const COPY_BY_CAPABILITY: Record<CloudCapability, CapabilityCopy> = {
  [CloudCapability.SHARE_PROOF]: {
    reason: 'Sharing a verification result with a teammate needs a hosted, linkable proof page.',
    unlockedBy: 'Link a free Reticle Cloud account (reticle login), then share the run.',
  },
  [CloudCapability.RUN_HISTORY]: {
    reason:
      'Run history beyond this session lives in the hosted dashboard; local keeps only a buffer.',
    unlockedBy: 'Link a free Reticle Cloud account to keep run history and trends.',
  },
  [CloudCapability.TEAM_REVIEW]: {
    reason: 'A shared review queue of pinned mistakes is a team feature — it needs a hosted store.',
    unlockedBy: 'Add your team to Reticle Cloud to share a review queue.',
  },
  [CloudCapability.CORPUS_HEAL]: {
    reason:
      'Corpus-ranked heal uses refactor outcomes learned across the fleet, served from the cloud.',
    unlockedBy: 'Enable the hosted heal service on a Reticle Cloud team plan.',
  },
  [CloudCapability.CI_GATE]: {
    reason:
      'Verify-before-merge is a governance gate that runs in your CI against a hosted policy.',
    unlockedBy: 'Configure the Reticle Cloud CI gate for your repository.',
  },
};

/** Build the canonical hint for a capability. Pure — the emitter decides WHEN, this decides WHAT. */
export function buildUpgradeHint(capability: CloudCapability): UpgradeHint {
  const copy = COPY_BY_CAPABILITY[capability];
  return {
    capability,
    reason: copy.reason,
    unlockedBy: copy.unlockedBy,
    learnMoreUrl: CLOUD_LEARN_MORE_URL,
  };
}

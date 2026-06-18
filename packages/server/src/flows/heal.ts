import {
  AnchorKind,
  DriftReason,
  HEAL_CONFIDENCE_MIN,
  type Drift,
  type FlowFile,
  type FlowStep,
  type FlowStepResult,
  type HealChange,
  type HealProposal,
} from '@syrin/iris-protocol';
import { editDistance } from './flow-replay.js';

/**
 * The pure proposal layer. It turns a `Drift` (with its already-
 * computed nearest testid) into a concrete, confidence-scored rebind. No new heuristics enter the
 * trust boundary: confidence is derived only from the existing case-insensitive edit distance, so
 * the "never silently rewrite a bad guess" invariant lives in a single numeric floor
 * (HEAL_CONFIDENCE_MIN). Separated from the iris_flow_heal tool so it is unit-testable without a
 * live session or the filesystem.
 *
 * FIRST CUT: testid-anchor rebinds only, scored by string distance.
 * Future: rebind by alternate anchors (role+name, signal correlation); multi-candidate
 * ranking when several testids tie; confidence beyond string distance (DOM-position / a11y-role
 * agreement, contract-diff awareness); healing degraded (ROLE-unresolved) steps; signal-drift
 * healing (signals have no nearest-match today — intentionally nearest:null, no proposal).
 */

/**
 * Normalize a case-insensitive edit distance to a (0,1] confidence: 1 on an exact match, decaying
 * with distance relative to the longer string's length. Always clamped to (0,1] — never 0, never
 * above 1 — so a present-but-distant testid is still legibly scored (below the floor), not dropped.
 */
export function confidenceFor(from: string, to: string): number {
  if (from === to) return 1;
  const span = Math.max(from.length, to.length);
  if (span === 0) return 1;
  const raw = 1 - editDistance(from, to) / span;
  if (raw >= 1) return 1;
  if (raw <= 0) return Number.EPSILON;
  return raw;
}

/**
 * Pure: rewrite the named steps' testid anchors (from→to) and return the new flow plus the changes
 * that actually applied. A change whose `from` no longer matches that step's testid anchor is
 * skipped (idempotent / defensive), never throwing. Shared by the on-disk writer (FlowStore.heal)
 * and the in-memory pre-write verification in iris_flow_heal, so both rewrite identically.
 */
export function applyHealChanges(
  flow: FlowFile,
  changes: HealChange[],
): { flow: FlowFile; applied: HealChange[] } {
  const byStep = new Map<number, HealChange>();
  for (const change of changes) byStep.set(change.step, change);
  const applied: HealChange[] = [];
  const steps = flow.steps.map((step, index): FlowStep => {
    const change = byStep.get(index);
    if (
      change === undefined ||
      step.anchor.kind !== AnchorKind.TESTID ||
      step.anchor.value !== change.from
    ) {
      return step;
    }
    applied.push(change);
    return { ...step, anchor: { kind: AnchorKind.TESTID, value: change.to } };
  });
  return { flow: { ...flow, steps }, applied };
}

/** Internal: propose with a caller-supplied floor (enables the tunable-confidence API). */
function proposeRebindWith(
  drift: Drift,
  step: number,
  minConfidence: number,
): HealProposal | undefined {
  if (drift.reasonKind !== DriftReason.TESTID_NOT_FOUND) return undefined;
  // Never auto-heal an ambiguous drift: when two present testids tie at the minimum distance, the
  // `nearest` pick is arbitrary, so a rebind would be a coin-flip that can land on the wrong element
  // and ship a bug green. Surface it (the drift still carries `nearest`) and defer to a human.
  if (drift.ambiguous === true) return undefined;
  const to = drift.nearest;
  if (to === null) return undefined;
  const confidence = confidenceFor(drift.anchor, to);
  if (confidence < minConfidence) return undefined;
  return { step, from: drift.anchor, to, confidence };
}

/**
 * Public compat wrapper — uses HEAL_CONFIDENCE_MIN (the existing default floor).
 * Prefer collectProposals(steps, minConfidence) for new callers.
 */
export function proposeRebind(drift: Drift, step: number): HealProposal | undefined {
  return proposeRebindWith(drift, step, HEAL_CONFIDENCE_MIN);
}

/**
 * Map step results → confident proposals (skips ok steps, signal drift, and below-floor drift).
 * Pass minConfidence to tighten (0.9 → near-certain only) or loosen (0.0 → all candidates)
 * the floor. Defaults to HEAL_CONFIDENCE_MIN (0.5) for backwards compatibility.
 */
export function collectProposals(
  steps: FlowStepResult[],
  minConfidence: number = HEAL_CONFIDENCE_MIN,
): HealProposal[] {
  const proposals: HealProposal[] = [];
  for (const step of steps) {
    if (step.drift === undefined) continue;
    const proposal = proposeRebindWith(step.drift, step.step, minConfidence);
    if (proposal !== undefined) proposals.push(proposal);
  }
  return proposals;
}

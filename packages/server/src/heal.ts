import {
  DriftReason,
  HEAL_CONFIDENCE_MIN,
  type Drift,
  type FlowStepResult,
  type HealProposal,
} from '@syrin/iris-protocol';
import { editDistance } from './flow-replay.js';

/**
 * M8 Stage B SELFHEAL — the pure proposal layer. It turns a Stage-A `Drift` (with its already-
 * computed nearest testid) into a concrete, confidence-scored rebind. No new heuristics enter the
 * trust boundary: confidence is derived only from the existing case-insensitive edit distance, so
 * the "never silently rewrite a bad guess" invariant lives in a single numeric floor
 * (HEAL_CONFIDENCE_MIN). Separated from the iris_flow_heal tool so it is unit-testable without a
 * live session or the filesystem.
 *
 * FIRST CUT: testid-anchor rebinds only, scored by string distance.
 * SELFHEAL future: rebind by alternate anchors (role+name, signal correlation); multi-candidate
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
 * A confident rebind for a TESTID drift, or undefined. Gates on: the drift is a testid miss
 * (not a signal), a nearest present testid exists, and its confidence clears HEAL_CONFIDENCE_MIN.
 * Below the floor → undefined (drift is still reported by the caller, just never auto-rewritten).
 */
export function proposeRebind(drift: Drift, step: number): HealProposal | undefined {
  if (drift.reasonKind !== DriftReason.TESTID_NOT_FOUND) return undefined;
  const to = drift.nearest;
  if (to === null) return undefined;
  const confidence = confidenceFor(drift.anchor, to);
  if (confidence < HEAL_CONFIDENCE_MIN) return undefined;
  return { step, from: drift.anchor, to, confidence };
}

/** Map step results → the confident proposals (skips ok steps, signal drift, and below-floor drift). */
export function collectProposals(steps: FlowStepResult[]): HealProposal[] {
  const proposals: HealProposal[] = [];
  for (const step of steps) {
    if (step.drift === undefined) continue;
    const proposal = proposeRebind(step.drift, step.step);
    if (proposal !== undefined) proposals.push(proposal);
  }
  return proposals;
}

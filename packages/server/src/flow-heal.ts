import { RebindStatus, type FlowStepResult, type RebindProposal } from '@iris/protocol';

/**
 * M8 Stage B self-healing — pure proposal building, separated from the iris_flow_heal tool so it
 * is unit-testable without a live session. For each drifted step that carries a nearest match,
 * build a RebindProposal:
 *   - nearest present  → PROPOSED (apply=false) or APPLIED (apply=true)
 *   - nearest === null → NONE (no fix exists — surfaced legibly, never silent)
 * Green steps yield no proposal. Rebinds testid anchors only this cut (role/name re-anchoring is
 * future); signal drift always has nearest===null → NONE.
 */
export function buildProposals(steps: FlowStepResult[], apply: boolean): RebindProposal[] {
  const proposals: RebindProposal[] = [];
  for (const step of steps) {
    const drift = step.drift;
    if (drift === undefined) continue;
    if (drift.nearest === null) {
      proposals.push({
        step: step.step,
        from: drift.anchor,
        to: drift.anchor,
        status: RebindStatus.NONE,
      });
      continue;
    }
    proposals.push({
      step: step.step,
      from: drift.anchor,
      to: drift.nearest,
      status: apply ? RebindStatus.APPLIED : RebindStatus.PROPOSED,
    });
  }
  return proposals;
}

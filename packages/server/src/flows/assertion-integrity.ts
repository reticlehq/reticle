import {
  flowExpectHasConsequence,
  flowExpectIsPresenceOnly,
  type FlowExpect,
} from '@reticlehq/core';

/**
 * Anti-reward-hacking (research-mandated). Test-gated agents pass gates by WEAKENING assertions — the
 * canonical documented failure. Flows are git-checked and agent-editable, so a mustHold that dropped
 * from a consequence (signal/net/state) to presence-only since the last passing run is a downgrade the
 * gate must flag as a first-class finding, never silently accept. This is the pure detector; the gate
 * and flow_verify surface it.
 */

/** True when `after` weakened `before` — a real consequence became a fakeable presence-only check. */
export function isAssertionDowngrade(
  before: FlowExpect | undefined,
  after: FlowExpect | undefined,
): boolean {
  return flowExpectHasConsequence(before) && flowExpectIsPresenceOnly(after);
}

export interface StepExpect {
  step: number;
  expect?: FlowExpect;
}

interface DowngradeFinding {
  step: number;
}

/**
 * Compare a flow's steps between its last-passing version and now (matched by step index). Reports each
 * step whose assertion tier dropped. Steps added/removed are out of scope here — deleted-flow detection
 * lives with the affected index.
 */
export function detectDowngrades(
  before: readonly StepExpect[],
  after: readonly StepExpect[],
): DowngradeFinding[] {
  const afterByStep = new Map(after.map((s) => [s.step, s.expect]));
  const findings: DowngradeFinding[] = [];
  for (const { step, expect } of before) {
    if (isAssertionDowngrade(expect, afterByStep.get(step))) findings.push({ step });
  }
  return findings;
}

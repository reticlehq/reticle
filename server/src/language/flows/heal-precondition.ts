/**
 * May this flow be healed at all?
 *
 * A heal re-points a drifted anchor at its nearest match. What stops that from becoming a lie is the
 * CONSEQUENCE: a locator healed to the wrong element cannot fake a signal, a request or a store
 * value. Measured in this repo's own bench at 2/2 — the element resolved perfectly and the flow
 * still went red, because the recorded signal never fired.
 *
 * A flow with no consequence has nothing to check the heal against. Re-pointing its anchor yields a
 * flow that passes forever and proves nothing, which is WORSE than the drift it replaced: the drift
 * was at least visible. That is the self-healing false green this product exists to prevent, and
 * building it as a feature would be the most expensive irony available.
 *
 * Presence-only is refused for the sharpest version of the same reason: "the element is there" is
 * exactly what a wrong rebind makes true, so it cannot be the thing that validates a rebind.
 *
 * `classifyFlowAssertions` already grades every flow this way. This is what turns that grade from a
 * label into a gate — the invariant its own file states: what the classifier describes and what the
 * engine enforces must move together.
 *
 * Pure: a flow in, a refusal or nothing out.
 */

import { HealStatus, type FlowFile } from '@reticlehq/core';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';

export interface HealRefusal {
  status: typeof HealStatus.UNFALSIFIABLE;
  message: string;
}

export function healPrecondition(flow: FlowFile): HealRefusal | undefined {
  const { grade } = classifyFlowAssertions(flow);
  if (grade === FlowAssertionGrade.ASSERTED) return undefined;
  const why =
    grade === FlowAssertionGrade.PRESENCE_ONLY
      ? 'it only checks that an element is present, which is exactly what a wrong rebind makes true'
      : 'it asserts nothing observable, so it would pass whether or not the feature works';
  return {
    status: HealStatus.UNFALSIFIABLE,
    message:
      `refusing to heal "${flow.name}": ${why}, so nothing here could catch a rebind that pointed ` +
      `at the wrong element. Give a step an \`expect\` naming a consequence the action CAUSES — a ` +
      `signal, a request, or a store value — or set the flow's \`success\`, then heal it.`,
  };
}

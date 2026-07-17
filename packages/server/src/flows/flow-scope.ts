/**
 * Project-scoping for the HUD's replay-flow list. One daemon can serve many apps (they all connect to
 * the same bridge port); its flow store is flat, so without scoping every app's HUD lists every other
 * app's flows. These pure helpers pick the flows that belong on a given session's panel and shape them
 * into replay chips — testable without a bridge or a filesystem.
 */
import { AnchorKind, type FlowFile } from '@reticlehq/core';

/** A replayable flow as the HUD renders it: a name + an optional page it can start from. */
export interface FlowChip {
  name: string;
  start?: string;
}

/**
 * A flow belongs on a session's HUD when it carries no projectId (legacy/global — visible everywhere
 * for back-compat) OR its projectId matches the connecting session's. A flow stamped for project A
 * never shows on project B's panel.
 */
export function flowInProjectScope(
  flowProjectId: string | undefined,
  sessionProjectId: string | undefined,
): boolean {
  return flowProjectId === undefined || flowProjectId === sessionProjectId;
}

/**
 * Build the project-scoped replay chips for a session. Each in-scope flow becomes a chip whose `start`
 * is its first step's testid anchor (so the panel can show it only on the page it can begin from);
 * flows starting from a non-testid anchor get a chip with no `start` (shown on every page).
 */
export function buildFlowChips(
  flows: readonly FlowFile[],
  sessionProjectId: string | undefined,
): FlowChip[] {
  const chips: FlowChip[] = [];
  for (const flow of flows) {
    if (!flowInProjectScope(flow.projectId, sessionProjectId)) continue;
    const first = flow.steps[0];
    const start =
      first !== undefined && first.anchor.kind === AnchorKind.TESTID
        ? first.anchor.value
        : undefined;
    chips.push(start === undefined ? { name: flow.name } : { name: flow.name, start });
  }
  return chips;
}

/**
 * Repair-packet generation — turn a failed flow replay into a concise, paste-ready instruction the
 * host's coding agent can act on to close its own loop. Pure + deterministic (no LLM): it lifts the
 * already-computed decision envelope (whatChanged / whereInSource / nextAction) into the artifact's
 * RepairPacket shape. This is the OEM self-heal value — a verdict that also says how to fix.
 */

import {
  ReplayStatus,
  type FlowReplayResult,
  type FlowStepResult,
  type RepairPacket,
  type SourceLocation,
} from '@reticle/protocol';

/** The step a replay broke at — drift takes precedence (the legible cause), else first non-ok step. */
function failingStepNumber(steps: ReadonlyArray<FlowStepResult>): number | undefined {
  const drifted = steps.find((s) => s.drift !== undefined);
  if (drifted !== undefined) return drifted.step;
  return steps.find((s) => !s.ok)?.step;
}

/** Parse a "file:line" source coordinate. Skips page URLs (which also contain colons). */
function parseSource(where: string | undefined): SourceLocation | undefined {
  if (where === undefined || where.includes('://')) return undefined;
  const match = /^(.*):(\d+)$/.exec(where);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return { file: match[1], line: Number(match[2]) };
  }
  return { file: where };
}

/** Compose the paste-ready fix instruction from the decision envelope. */
function suggestedPrompt(
  name: string,
  actual: string,
  where: string | undefined,
  nextAction: string | undefined,
): string {
  const parts = [`Fix the "${name}" flow.`, actual.endsWith('.') ? actual : `${actual}.`];
  if (where !== undefined) parts.push(`Look at ${where}.`);
  if (nextAction !== undefined) parts.push(nextAction);
  return parts.join(' ');
}

/**
 * Build a repair packet for a failed replay, or undefined when the flow passed. The actual cause is
 * the decision's whatChanged, falling back to the replay error or a generic message.
 */
export function buildRepairPacket(replay: FlowReplayResult): RepairPacket | undefined {
  if (replay.status === ReplayStatus.OK) return undefined;

  const decision = replay.decision;
  const actual = decision?.whatChanged ?? replay.error?.message ?? 'the flow failed';
  const where = decision?.whereInSource;
  const sourceLocation = parseSource(where);
  const step = failingStepNumber(replay.steps);

  return {
    flow: replay.name,
    ...(step !== undefined ? { step } : {}),
    expected: `the "${replay.name}" flow holds (its steps run and its success consequence fires)`,
    actual,
    ...(sourceLocation !== undefined ? { sourceLocation } : {}),
    suggestedPrompt: suggestedPrompt(replay.name, actual, where, decision?.nextAction),
  };
}

/** Build the repair packets for a set of replays (failed ones only). */
export function buildRepairPackets(replays: ReadonlyArray<FlowReplayResult>): RepairPacket[] {
  return replays.map(buildRepairPacket).filter((p): p is RepairPacket => p !== undefined);
}

import { FlowProgressStatus, ReplayStatus, ReticleCommand } from '@reticlehq/core';
import type { FlowReplayResult } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { replayAndLearn } from './flow-learning.js';

/** The session a HUD replay reports to. Resolved per message: a replay usually reloads the page. */
interface ProgressTarget {
  pushNarration(text: string): void;
  pushView(name: typeof ReticleCommand.FLOW_PROGRESS, args: object): void;
}

/** A human-facing one-liner for a panel replay verdict — ✓ passed / ⚠ drifted / ✗ errored / ? unverifiable. */
export function replayVerdictLine(result: FlowReplayResult): string {
  if (result.status === ReplayStatus.OK) return `✓ "${result.name}" passed`;
  if (result.status === ReplayStatus.DRIFT)
    return `⚠ "${result.name}" drifted — a step no longer matches`;
  if (result.status === ReplayStatus.UNVERIFIABLE)
    return `? "${result.name}" unverifiable — ${result.unverifiable?.reason ?? 'could not be graded'}`;
  return `✗ "${result.name}" failed — ${result.error?.message ?? 'could not replay'}`;
}

/**
 * Replay a saved flow because a person pressed ▶ in the HUD, with no agent involved.
 *
 * The chip they pressed shows the replay as it runs: a progress push after every step, and the
 * verdict at the end, sent to whichever session holds the tab at that moment (a replay reloads the
 * page, and the session object from before the reload no longer has a socket). The verdict also
 * lands in the Agent Log as a line, where the "See the logs" link on the chip leads.
 */
export async function replayFromHud(
  deps: ToolDeps,
  resolve: (sessionId: string) => ProgressTarget | undefined,
  sessionId: string,
  flowName: string,
): Promise<void> {
  const progress = (done: number, total: number, status: FlowProgressStatus): void =>
    resolve(sessionId)?.pushView(ReticleCommand.FLOW_PROGRESS, {
      name: flowName,
      done,
      total,
      status,
    });
  resolve(sessionId)?.pushNarration(`▶ Replaying "${flowName}"…`);
  progress(0, 0, FlowProgressStatus.PLAYING);
  let total = 0;
  let done = 0;
  try {
    const result = await replayAndLearn(deps, {
      flowName,
      sessionId,
      onStep: (stepsDone: number, stepsTotal: number) => {
        done = stepsDone;
        total = stepsTotal;
        progress(done, total, FlowProgressStatus.PLAYING);
      },
    });
    const passed = ReplayStatus.OK === result.status;
    progress(
      passed ? total : done,
      total,
      passed ? FlowProgressStatus.PASSED : FlowProgressStatus.FAILED,
    );
    resolve(sessionId)?.pushNarration(replayVerdictLine(result));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    progress(done, total, FlowProgressStatus.FAILED);
    resolve(sessionId)?.pushNarration(`✗ Replay "${flowName}" failed — ${message}`);
  }
}

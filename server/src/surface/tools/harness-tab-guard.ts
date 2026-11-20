/**
 * One driver per tab. The Harness clicking through a page while the agent clicks too is two hands on
 * one mouse: neither result means anything. While a Harness run drives a tab, the agent's own
 * actions in it are refused with how to wait for the run or stop it; its reads still run.
 */
import { ReticleTool } from '@reticlehq/core';
import { runningDrive, runningDrives } from '@/features/harness/drive-runs.js';
import { currentDrivenBy } from '@/hooks/driven-by.js';
import type { ToolDeps } from './tool-kit.js';
import { sessionIdFromArgs } from './tools-helpers.js';
import { VERDICT_TOOLS } from './feedback-tools.js';
/** Said when the agent acts in a tab the Harness is driving. */
export const msgHarnessHasTheTab = (runId: string): string =>
  `Reticle Harness is driving this tab now (run ${runId}), so this action did not run. Wait for ` +
  `its result with ${ReticleTool.VERIFY} { action: "explore", runId: "${runId}" }, or stop it ` +
  `with the same call and stop: true, then act.`;

/** The Harness run driving the tab this agent call would act on, unless the call is the Harness's. */
export function harnessDriving<Ext>(
  deps: ToolDeps<Ext>,
  args: Record<string, unknown>,
): string | undefined {
  // No drive anywhere is the usual case, and it touches nothing: not even which tab this call is.
  if (currentDrivenBy() !== undefined || 0 === runningDrives().length) return undefined;
  let sessionId: string | undefined;
  try {
    sessionId = deps.sessions.resolve(sessionIdFromArgs(args)).id;
  } catch {
    return undefined; // no tab: the action fails on its own, with the no-session answer
  }
  return runningDrive(sessionId)?.harnessRun;
}

/**
 * A verdict never grades a tab it had to guess.
 *
 * With several tabs connected, a call that names no `sessionId` is resolved by a heuristic: the only
 * healthy tab, the only focused one, or the freshest heartbeat. That is a fair guess for a click. It
 * is not a fair basis for a verdict: a "no" about the tab the agent did not mean is a false verdict,
 * and nothing in the answer says a guess was made. The human's focused tab is often not the tab the
 * agent drives, so even focus is not enough. A verdict tool therefore refuses, and lists the tabs.
 */

interface ConnectedTab {
  sessionId: string;
  url?: string | null;
}

/** `act` is a verdict only when it carries `steps`; a single click or fill grades nothing. */
function isVerdictCall(toolName: string, args: Record<string, unknown>): boolean {
  if (!VERDICT_TOOLS.has(toolName)) {
    return false;
  }
  return ReticleTool.ACT !== toolName || Array.isArray(args['steps']);
}

/**
 * The refusal for a verdict call that named no session while more than one tab is connected, or
 * `undefined` when the call may go on. The text starts with the resolver's own ambiguity sentence,
 * so the recovery hint and the refusal telemetry already know it.
 */
export function guessedVerdictTab(
  toolName: string,
  args: Record<string, unknown>,
  explicitSessionId: string | undefined,
  /** Read only for a verdict call that named no session: most calls never need the list. */
  connected: () => readonly ConnectedTab[],
): string | undefined {
  if (explicitSessionId !== undefined || !isVerdictCall(toolName, args)) {
    return undefined;
  }
  const all = connected();
  if (all.length < 2) {
    return undefined;
  }
  const tabs = all.map((t) => `${t.sessionId} (${t.url ?? 'no url'})`).join(', ');
  return `multiple sessions connected — pass sessionId to target one: ${tabs}. A verdict is never graded against a guessed tab.`;
}

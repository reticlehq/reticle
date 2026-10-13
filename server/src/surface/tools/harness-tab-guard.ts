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

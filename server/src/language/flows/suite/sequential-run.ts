/**
 * The sequential half of `reticle_verify { action: "flows" | "change" }`.
 *
 * Flows replay one after the other against one live tab, with no limit on the total time. When the
 * browser session was lost part-way through, every remaining flow waited for a page that never came,
 * and the MCP client gave up (about 300 s) with no result at all - including for the flows that had
 * already run. So the loop now stops at two points, and says so:
 *
 * - the total time budget is spent: no further flow is started;
 * - the session is gone after a flow: the rest cannot run, so they are not attempted.
 *
 * Kept free of IO (the clock, the liveness probe and the replay are injected) so both stops are
 * tested with a fake clock.
 */

import { z } from 'zod';
import { SuiteStopReason, SuiteVerdictStatus } from '@reticlehq/core';

/** Below the roughly 300 s at which common MCP clients stop waiting, so a result can still be returned. */
export const DEFAULT_SUITE_BUDGET_MS = 240_000;

/** An hour: more than that is not a budget, and a client will have given up long before. */
export const MAX_SUITE_BUDGET_MS = 3_600_000;

export interface SuiteStop {
  reason: SuiteStopReason;
  /** For SESSION_LOST: the flow that was running when the session went. */
  flow?: string;
  budgetMs?: number;
  nextAction: string;
}

export interface SequentialRun<R> {
  results: R[];
  /** Selected flows that were never started, in order. */
  notRun: string[];
  stopped?: SuiteStop;
}

export interface SequentialRunOptions<R> {
  now: () => number;
  budgetMs: number;
  /** True while the session the flows drive is still there. Probed after each flow. */
  sessionAlive: () => boolean;
  run: (name: string) => Promise<R>;
}

export async function runSequentially<R>(
  names: readonly string[],
  options: SequentialRunOptions<R>,
): Promise<SequentialRun<R>> {
  const deadline = options.now() + options.budgetMs;
  const results: R[] = [];
  for (const [index, name] of names.entries()) {
    // The first flow always starts: a budget that stops a suite before anything ran proves nothing.
    if (index > 0 && options.now() >= deadline) {
      return {
        results,
        notRun: names.slice(index),
        stopped: {
          reason: SuiteStopReason.TIME_BUDGET,
          budgetMs: options.budgetMs,
          nextAction:
            'run the flows listed in notRun in a new call (pass `names`), or raise `budgetMs` if your client waits longer',
        },
      };
    }
    results.push(await options.run(name));
    if (index < names.length - 1 && !options.sessionAlive()) {
      return {
        results,
        notRun: names.slice(index + 1),
        stopped: {
          reason: SuiteStopReason.SESSION_LOST,
          flow: name,
          nextAction:
            'reconnect the app (open it in a tab, or call reticle_sessions to find the live one), then run the flows listed in notRun with `names`',
        },
      };
    }
  }
  return { results, notRun: [] };
}

/**
 * Mark a verdict `partial` when the suite stopped early. The ran flows keep their counts and
 * failures; the summary leads with what did not run, because a green count over half a suite must
 * not read as a pass.
 */
export function withStop<V extends { status: SuiteVerdictStatus; summary: string }>(
  verdict: V,
  notRun: readonly string[],
  stopped: SuiteStop | undefined,
): V & { notRun?: string[]; stopped?: SuiteStop } {
  if (stopped === undefined) {
    return verdict;
  }
  const why =
    stopped.reason === SuiteStopReason.TIME_BUDGET
      ? `the ${String(Math.round((stopped.budgetMs ?? 0) / 1000))} s total budget ran out`
      : `the browser session was lost while "${stopped.flow ?? ''}" was running`;
  return {
    ...verdict,
    status: SuiteVerdictStatus.PARTIAL,
    summary: `PARTIAL - ${why}; ${String(notRun.length)} flow(s) did not run (${notRun.join(', ')}). Of those that ran: ${verdict.summary}`,
    notRun: [...notRun],
    stopped,
  };
}

/** The `budgetMs` input of the suite tools. */
export const BUDGET_MS_ARG = z
  .number()
  .finite()
  .int()
  .positive()
  .max(MAX_SUITE_BUDGET_MS)
  .optional()
  .describe(
    `Total time budget for the sequential run, in milliseconds (default ${String(DEFAULT_SUITE_BUDGET_MS)}, below the ~300 s at which common MCP clients stop waiting). When it is spent no further flow is started: the call returns status "partial" with the finished results and the flows in notRun.`,
  );

/** The two output fields a "partial" suite adds. */
export const PARTIAL_OUTPUT = {
  notRun: z
    .array(z.string())
    .optional()
    .describe(
      'Present on a "partial" suite: the selected flows that were never started because the time budget ran out or the session was lost.',
    ),
  stopped: z
    .object({
      reason: z.enum([SuiteStopReason.TIME_BUDGET, SuiteStopReason.SESSION_LOST]),
      flow: z.string().optional(),
      budgetMs: z.number().optional(),
      nextAction: z.string(),
    })
    .optional()
    .describe(
      'Present on a "partial" suite: why it ended early (time_budget | session_lost), the flow that lost the session, and one next action.',
    ),
};

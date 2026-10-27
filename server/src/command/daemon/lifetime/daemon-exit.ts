/**
 * The daemon's exit, with a bound (#1937).
 *
 * The exit used to await the telemetry summary and then `server.close()`, with no limit on the
 * close. The close waits for the browser pool, the cloud sync flush and every open HTTP connection.
 * When one of them never settled, the process stayed alive with its port held, and every tool call
 * found a daemon that did not answer.
 */

import { log } from '@/log.js';

export const ExitCode = {
  CLEAN: 0,
  FAILED: 1,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * The most the summary and the close get together. The summary send has its own 2s bound, and the
 * pool needs a few seconds to close its browsers.
 */
export const DAEMON_EXIT_BUDGET_MS = 10_000;

/** Send the summary, close, and resolve to the exit code. Never takes longer than `budgetMs`. */
export async function exitAfterClose(steps: {
  summary: () => Promise<void>;
  close: () => Promise<void>;
  budgetMs?: number;
}): Promise<ExitCode> {
  const budgetMs = steps.budgetMs ?? DAEMON_EXIT_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the daemon did not finish its shutdown within ${String(budgetMs)}ms`));
    }, budgetMs);
  });
  try {
    await Promise.race([steps.summary().then(steps.close), deadline]);
    return ExitCode.CLEAN;
  } catch (err: unknown) {
    log('reticle_daemon_close_error', { error: err instanceof Error ? err.message : String(err) });
    return ExitCode.FAILED;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The daemon's exit must not wait forever (#1937).
 *
 * The exit path awaited `server.close()` with no bound. That close waits for the browser pool, the
 * cloud sync flush and every open HTTP connection. One that never settles kept the process alive
 * with its port held, and the next tool call found a daemon that did not answer.
 */

import { describe, expect, it } from 'vitest';
import { ExitCode, exitAfterClose } from './daemon-exit.js';

/** Short for the test. The bound is what is asserted, not a duration. */
const BUDGET_MS = 20;
const never = (): Promise<void> => new Promise<void>(() => undefined);
const done = (): Promise<void> => Promise.resolve();

describe('exitAfterClose', () => {
  it('exits clean when the summary and the close both finish', async () => {
    expect(await exitAfterClose({ summary: done, close: done, budgetMs: BUDGET_MS })).toBe(
      ExitCode.CLEAN,
    );
  });

  it('exits when the close never settles', async () => {
    expect(await exitAfterClose({ summary: done, close: never, budgetMs: BUDGET_MS })).toBe(
      ExitCode.FAILED,
    );
  });

  it('exits when the telemetry summary never settles', async () => {
    expect(await exitAfterClose({ summary: never, close: done, budgetMs: BUDGET_MS })).toBe(
      ExitCode.FAILED,
    );
  });

  it('exits when the close throws', async () => {
    const fails = (): Promise<void> => Promise.reject(new Error('bridge close failed'));
    expect(await exitAfterClose({ summary: done, close: fails, budgetMs: BUDGET_MS })).toBe(
      ExitCode.FAILED,
    );
  });
});

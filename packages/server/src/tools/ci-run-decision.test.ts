/**
 * A retry must be scoped to the failures where retrying is safe, and must always say it retried.
 *
 * `scripts/ci-run.mjs` exists because Windows runners intermittently refuse to START a process:
 * exit `-1073741502` (`0xC0000142`, STATUS_DLL_INIT_FAILED), no output, sometimes 0.02s in. The
 * product is fine and the red is indistinguishable from a real failure until somebody recognises an
 * NT status code.
 *
 * The dangerous version of this fix is a retry-everything wrapper, which hides real failures and
 * turns a flaky suite into a trusted-but-wrong one. So the decision is pinned here rather than left
 * to a reading of the script:
 *
 *   - retry ONLY the codes that mean the process never started, where no user code ran and there is
 *     no partial state for a second attempt to be confused by
 *   - a normal test failure (1) is never retried
 *   - every retry is announced, and the announcement says it is an ENVIRONMENT failure
 *
 * Tested from this package because `scripts/` has no test setup of its own and this is the gate that
 * always runs. See https://github.com/reticlehq/reticle/issues/273.
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'ci-run.mjs');

const load = async (): Promise<{
  runnerLevelFailure: (code: number | null) => string | null;
  explain: (code: number, detail: string, willRetry: boolean) => string;
  RUNNER_LEVEL_EXIT_CODES: Map<number, string>;
  runnerLevelInOutput: (output: string) => string | null;
}> => (await import(SCRIPT)) as never;

describe('only a failure to START the process is retried', () => {
  it('recognises STATUS_DLL_INIT_FAILED, the one actually observed', async () => {
    const { runnerLevelFailure } = await load();
    expect(runnerLevelFailure(-1073741502)).toContain('0xC0000142');
  });

  it('does NOT retry an ordinary test failure', async () => {
    // The line between a useful wrapper and one that hides defects. Exit 1 is a suite that ran and
    // failed; running it again would either waste a runner or, worse, pass on a flake and bury a
    // real regression.
    const { runnerLevelFailure } = await load();
    expect(runnerLevelFailure(1)).toBeNull();
  });

  it('does NOT retry a success, a signal death, or an unknown code', async () => {
    const { runnerLevelFailure } = await load();
    expect(runnerLevelFailure(0)).toBeNull();
    expect(runnerLevelFailure(137)).toBeNull(); // SIGKILL, e.g. the OOM killer — a real signal
    expect(runnerLevelFailure(-9)).toBeNull();
    expect(runnerLevelFailure(null)).toBeNull();
  });

  it('keeps the retryable set small and closed', async () => {
    // Deliberately not "any large negative number". A crash inside a real test can also produce an
    // unusual code, and retrying that would hide a genuine defect behind an infrastructure excuse.
    const { RUNNER_LEVEL_EXIT_CODES } = await load();
    expect(RUNNER_LEVEL_EXIT_CODES.size).toBeLessThanOrEqual(4);
  });
});

describe('the log says which kind of failure this was', () => {
  it('names it an environment failure and says no user code ran', async () => {
    const { explain, RUNNER_LEVEL_EXIT_CODES } = await load();
    const detail = RUNNER_LEVEL_EXIT_CODES.get(-1073741502) ?? '';
    const text = explain(-1073741502, detail, true);

    // The whole point: a reader who has never seen 0xC0000142 should not have to look it up.
    expect(text).toContain('environment failure');
    expect(text).toContain('not a test failure');
    expect(text).toContain('no user code ran');
  });

  it('announces the retry, so a silent second attempt is impossible', async () => {
    const { explain } = await load();
    expect(explain(-1073741502, 'detail', true)).toContain('Retrying once');
  });

  it('says so when the retry hit it too, rather than going quiet', async () => {
    const { explain } = await load();
    const text = explain(-1073741502, 'detail', false);
    expect(text).toContain('retry hit it as well');
    expect(text).not.toContain('Retrying once');
  });
});

/**
 * The exit code is not the only place a runner-level failure shows up.
 *
 * Every step this wrapper wraps runs through turbo, and turbo CATCHES a child's exit code and exits
 * 1 itself, printing the real one:
 *
 *   ERROR  @reticlehq/vite-plugin#build: command (...) pnpm.CMD run build exited (-1073741502)
 *   ERROR  run failed: command  exited (-1073741502)
 *   Process completed with exit code 1
 *
 * So the wrapper's own child exits 1 — correctly not retryable — and the STATUS_DLL_INIT_FAILED
 * underneath it was invisible. Watching only the exit code made this useless for exactly the
 * commands it wraps, which is not a hypothetical: it turned main red on a changelog-only commit
 * while this wrapper was live and did nothing.
 */
describe('a runner-level failure swallowed by an inner wrapper is still recognised', () => {
  it('finds the NT status in turbo’s own error line', async () => {
    const { runnerLevelInOutput } = await load();
    const turbo =
      'ERROR  @reticlehq/vite-plugin#build: command (D:\\a\\reticle) pnpm.CMD run build exited (-1073741502)\n' +
      'ERROR  run failed: command  exited (-1073741502)\n';
    expect(runnerLevelInOutput(turbo)).toContain('0xC0000142');
  });

  it('says nothing about ordinary output', async () => {
    const { runnerLevelInOutput } = await load();
    expect(runnerLevelInOutput('3776 tests passed\nDone in 12s\n')).toBeNull();
    expect(runnerLevelInOutput('')).toBeNull();
  });

  it('does not fire on an exit code that merely resembles one', async () => {
    // The scan is over a closed list of full codes, not a pattern for "large negative number".
    const { runnerLevelInOutput } = await load();
    expect(runnerLevelInOutput('exited (-1073741) and (-107374150)')).toBeNull();
  });
});

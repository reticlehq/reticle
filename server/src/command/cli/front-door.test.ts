import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_VERSION } from '../version/server-version.js';
import { REPO_ROOT } from '../../repo-root.js';

/**
 * What a person gets in their first two minutes, checked against the program they actually run.
 *
 * Three defects in three days lived here, and every one was correct at the unit level:
 *
 *   - `reticle init --help` answered with an error, because the flag was recognised only in first
 *     position;
 *   - `reticle link --help` RAN the command and reached for the network, because the cloud commands
 *     are dispatched before the parser the fix lived in;
 *   - `reticle version` printed nothing a script could read, because it existed only as an event on
 *     stderr.
 *
 * The unit tests were not wrong about any of it. They call a function and check what it returns,
 * which cannot see which stream something was written to, what the exit code ended up being, or in
 * what order the dispatcher hands work off. Those only exist once the program is assembled.
 *
 * So this spawns the built CLI. It is slower than a unit test and it is the only thing here that
 * would have caught any of the three.
 *
 * Each check spawns a real process, and there are more than a dozen of them. Under a loaded runner --
 * the full gate, or a machine running several suites at once -- that exceeds vitest's five-second
 * default and the suite fails for a reason that has nothing to do with the code. The ceiling below is
 * a BOUND, not a duration: nothing here asserts how long anything took, which this repository forbids
 * outright, so raising it cannot hide a regression. A broken expectation still fails, just later.
 *
 * Everything below must work with no network, no daemon and no project. That is the state a new
 * person is in, and it is also what keeps this runnable anywhere.
 *
 * It tests `dist`, so it needs the build to be current. `pnpm verify` builds first and CI builds
 * first, which covers every route anybody actually takes. A staleness check by file timestamp was
 * tried here and removed: a cached build does not rewrite `dist`, so the timestamp stays old while
 * the contents are perfectly correct, and the check failed on a healthy tree. A guard that cries
 * wolf on a cache hit is one people delete.
 */

// Named rather than counted, and named where the command actually builds to. It moved into
// `command/` with the rest of what a person runs, and a count of directories would have gone on
// pointing at a file that is not there -- which this check reports as "there is nothing to test".
const CLI = join(REPO_ROOT, 'server', 'dist', 'command', 'cli.js');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): Result {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Commands whose `--help` must answer rather than act.
 *
 * The two families are here on purpose: `init` and `serve` reach the typed parser, `link` and `push`
 * are dispatched before it. They took separate fixes, so they need separate checks.
 */
const HELP_MUST_ANSWER = ['init', 'serve', 'status', 'link', 'push', 'runs'];

describe('the first commands anybody types', { timeout: 30_000 }, () => {
  it('the built CLI is there to test', () => {
    // Without this the whole file would pass by failing to find anything to run.
    expect(existsSync(CLI), `${CLI} is missing — run \`pnpm build\` first`).toBe(true);
  });

  describe.each(HELP_MUST_ANSWER)('%s --help', (command) => {
    it('answers with usage and succeeds', () => {
      const r = run(command, '--help');
      expect(r.code, `${command} --help exited ${String(r.code)}`).toBe(0);
      expect(r.stdout).toContain('usage:');
    });

    it('says nothing on the error stream, because nothing went wrong', () => {
      // Asking a tool what it does and being answered on stderr with a non-zero exit reads as a
      // broken install. That is precisely how this looked before it was fixed.
      expect(run(command, '--help').stderr).toBe('');
    });
  });

  it('the short flag works too', () => {
    expect(run('init', '-h').code).toBe(0);
  });

  it('the version is on stdout, bare, so a script or a bug report can capture it', () => {
    expect(run('version').stdout.trim()).toBe(SERVER_VERSION);
    expect(run('--version').stdout.trim()).toBe(SERVER_VERSION);
  });

  it('an unknown command fails, and says what the real ones are', () => {
    // The negative control. If every command "succeeded", the checks above would mean nothing.
    const r = run('deffinitelynotacommand');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage:');
  });
});

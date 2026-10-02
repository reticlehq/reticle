/**
 * A daemon must outlive the tool call that started it.
 *
 * The agent that starts a daemon usually does it from inside one shell command, and that command
 * ends a second later. If the daemon is in the caller's process group it dies with it: the log shows
 * `reticle_daemon_signalled {"signal":"SIGTERM"}` within a second of each such command finishing,
 * and from the outside it reads as "the daemon keeps dying" with no visible cause. That is named in
 * [#126](https://github.com/reticlehq/reticle/issues/126) as the mechanism behind most such reports.
 *
 * Two things have to hold, and only together:
 *
 *   - `detached: true`, which on POSIX means `setsid()` — a new session and process group, so a
 *     signal sent to the SPAWNER's group cannot reach the daemon. Without it the daemon dies with
 *     whatever reaped the tool call.
 *   - `unref()`, so the parent's event loop is not held open by the child. Without it the CLI
 *     command that started the daemon never exits, and the agent waits forever on a call that
 *     already did its job.
 *
 * Verified end to end by hand on macOS before this was written: a daemon started inside a shell that
 * was then killed with `kill -TERM -<pgid>` was still listening afterwards. That is the real proof
 * and it is not automatable cheaply or portably — a spawn test that starts real daemons is slow,
 * needs a free port, and `setsid` does not exist on macOS to set the scenario up. So the invariant is
 * pinned HERE, on the two flags, in the gate that always runs.
 *
 * These are one-word edits for someone refactoring the spawn path, and neither has a visible effect
 * on the machine of the person making the change: the daemon still starts, the tests still pass, and
 * the breakage only appears for an agent whose harness reaps its tool calls.
 */

import { describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDaemon, type SpawnDaemonDeps, type SpawnedChild } from './daemon.js';

interface Recorded {
  detached?: boolean;
  unrefCalled: boolean;
}

/**
 * Deps that record how the child was spawned, and let the spawn otherwise succeed.
 *
 * The file operations are real against a temp home, because `spawnDaemon` takes its O_EXCL lock on
 * the pidfile and returns false without ever reaching the spawn if that does not work.
 */
function recordingDeps(record: Recorded): SpawnDaemonDeps {
  const home = mkdtempSync(join(tmpdir(), 'reticle-spawn-'));
  return {
    home,
    openFile: (path, flags) => openSync(path, flags),
    closeFile: (fd) => {
      closeSync(fd);
    },
    fileSize: () => 0,
    renameFile: () => undefined,
    spawnChild: (_command, _args, options): SpawnedChild => {
      record.detached = options.detached;
      return {
        pid: 4242,
        on: () => undefined,
        unref: () => {
          record.unrefCalled = true;
        },
      };
    },
    pidAlive: () => false,
  };
}

describe('the daemon is started so it can outlive its spawner', () => {
  it('spawns DETACHED, so a signal to the caller’s process group cannot reach it', () => {
    const record: Recorded = { unrefCalled: false };
    expect(
      spawnDaemon(process.execPath, '/tmp/does-not-matter.js', [], 4999, recordingDeps(record)),
    ).toBe(true);

    expect(
      record.detached,
      'without detached:true the daemon shares the process group of the shell that started it, so ' +
        'whatever reaps the agent’s tool call takes the daemon with it — and the user sees only ' +
        '"the daemon keeps dying"',
    ).toBe(true);
  });

  it('unrefs the child, so the command that started it can exit', () => {
    const record: Recorded = { unrefCalled: false };
    spawnDaemon(process.execPath, '/tmp/does-not-matter.js', [], 4998, recordingDeps(record));

    expect(
      record.unrefCalled,
      'without unref() the parent’s event loop is held open by the child, so the CLI call that ' +
        'started the daemon never returns and the agent blocks on work that is already done',
    ).toBe(true);
  });
});

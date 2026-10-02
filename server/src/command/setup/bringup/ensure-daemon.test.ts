/**
 * A daemon already on the port is adopted only when it speaks our wire contract.
 *
 * It used to be adopted whenever it answered `/status`. An older Reticle there (a 2.x daemon under a
 * 3.x SDK) refused every hello from the freshly instrumented page ("bridge refused the connection:
 * invalid message"), and init then waited out its budget and blamed the page.
 */

import { describe, expect, it } from 'vitest';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { daemonSkew } from '@/command/cli/launch/cli-launch.js';
import { EnsureDaemon, ensureDaemon, retireMovedDaemons } from './ensure-daemon.js';

const PORT = 4400;

function deps(
  over: {
    status?: unknown;
    replaced?: boolean;
  } = {},
) {
  const calls = { spawned: 0, replaced: 0 };
  // Usable until replaced; after that the port is ours once spawn has run.
  let running = true;
  return {
    calls,
    deps: {
      // The real judge, so these cases pin the rule and not a stand-in for it.
      skewed: (status: unknown) => undefined !== daemonSkew(status),
      usable: () => Promise.resolve(running),
      status: () => Promise.resolve(over.status),
      replace: () => {
        calls.replaced += 1;
        if (false !== over.replaced) running = false;
        return Promise.resolve(false !== over.replaced);
      },
      spawn: () => {
        calls.spawned += 1;
        running = true;
        return true;
      },
      starting: () => false,
      waitReady: () => Promise.resolve(undefined),
      scriptPath: '/cli.js',
    },
  };
}

describe('ensureDaemon', () => {
  it('adopts a daemon that speaks our contract', async () => {
    const { deps: d, calls } = deps({ status: { contract: CONTRACT_FINGERPRINT } });
    expect((await ensureDaemon(PORT, d)).state).toBe(EnsureDaemon.ADOPTED);
    expect(calls.replaced).toBe(0);
  });

  it('replaces an idle daemon on another contract with one of ours', async () => {
    const { deps: d, calls } = deps({
      status: { contract: 'older', version: '2.14.0', sessionCount: 0, sessions: [] },
    });
    const result = await ensureDaemon(PORT, d);
    expect(result.state).toBe(EnsureDaemon.REPLACED);
    expect(calls.replaced).toBe(1);
    expect(calls.spawned).toBe(1);
    expect(result.message).toContain('2.14.0');
  });

  it('replaces a daemon too old to report a contract at all, when its version differs', async () => {
    const { deps: d } = deps({ status: { version: '2.14.0', sessions: [] } });
    expect((await ensureDaemon(PORT, d)).state).toBe(EnsureDaemon.REPLACED);
  });

  it('refuses to take a skewed daemon from under live sessions, and says the one command', async () => {
    const { deps: d, calls } = deps({
      status: {
        contract: 'older',
        version: '2.14.0',
        sessionCount: 1,
        sessions: [{ sessionId: 's1', url: 'http://localhost:3000/' }],
      },
    });
    const result = await ensureDaemon(PORT, d);
    expect(result.state).toBe(EnsureDaemon.SKEWED_IN_USE);
    expect(calls.replaced).toBe(0);
    expect(result.message).toContain(`kill --port ${String(PORT)}`);
  });

  it('is unavailable, not adopted, when the skewed daemon will not go', async () => {
    const { deps: d } = deps({
      status: { contract: 'older', version: '2.14.0', sessions: [] },
      replaced: false,
    });
    expect((await ensureDaemon(PORT, d)).state).toBe(EnsureDaemon.UNAVAILABLE);
  });

  /*
   * A fresh HOME, and something else (the editor's `reticle mcp`) already spawning the daemon: our
   * spawn loses the pid-file lock and returns false. init used to read that as "could not start the
   * Reticle daemon" and the daemon came up seconds later. The bind is the answer, not the spawn.
   */
  it('waits for the bind when another process already holds the spawn lock', async () => {
    let bound = false;
    const d = {
      ...deps().deps,
      usable: () => Promise.resolve(bound),
      spawn: () => false,
      starting: () => true,
      waitReady: () => {
        bound = true;
        return Promise.resolve(undefined);
      },
    };
    expect((await ensureDaemon(PORT, d)).state).toBe(EnsureDaemon.STARTED);
  });

  it('is unavailable at once when the spawn failed and nothing else is starting one', async () => {
    let waited = false;
    const d = {
      ...deps().deps,
      usable: () => Promise.resolve(false),
      spawn: () => false,
      starting: () => false,
      waitReady: () => {
        waited = true;
        return Promise.resolve(undefined);
      },
    };
    expect((await ensureDaemon(PORT, d)).state).toBe(EnsureDaemon.UNAVAILABLE);
    expect(waited).toBe(false);
  });
});

/**
 * `init --port <new>` started a daemon on the new port and left this project's old one running. The
 * build plugin found both, dialled the old one, and init — waiting on the new one — exited 1 with
 * "connected to a DIFFERENT Reticle daemon". So init stops the old one, unless another project's tab
 * is still on it.
 */
describe('retireMovedDaemons', () => {
  const mine = { port: 4400, pid: 11, cwd: '/app', projectId: 'mine', startedAt: 1 };

  function retire(status: unknown, entries = [mine]) {
    const stopped: number[] = [];
    const run = retireMovedDaemons('mine', 4460, {
      registered: () => entries,
      status: () => Promise.resolve(status),
      stop: (port) => {
        stopped.push(port);
        return Promise.resolve(true);
      },
    });
    return { run, stopped };
  }

  it("stops this project's daemon on the port it moved away from", async () => {
    const { run, stopped } = retire({ sessions: [{ sessionId: 'a', projectId: 'mine' }] });
    expect(await run).toEqual([4400]);
    expect(stopped).toEqual([4400]);
  });

  it("leaves it running while another project's tab is on it", async () => {
    const { run, stopped } = retire({ sessions: [{ sessionId: 'b', projectId: 'other' }] });
    expect(await run).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("never touches the port init is moving to, or another project's daemon", async () => {
    const { run, stopped } = retire({ sessions: [] }, [
      { ...mine, port: 4460 },
      { ...mine, port: 4401, projectId: 'other' },
    ]);
    expect(await run).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('does nothing for a project with no id to match on', async () => {
    const stopped: number[] = [];
    await retireMovedDaemons(undefined, 4460, {
      registered: () => [mine],
      status: () => Promise.resolve({ sessions: [] }),
      stop: (port) => {
        stopped.push(port);
        return Promise.resolve(true);
      },
    });
    expect(stopped).toEqual([]);
  });
});

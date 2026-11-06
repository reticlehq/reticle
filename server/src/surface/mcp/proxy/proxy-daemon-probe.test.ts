/**
 * `waitForDaemon` used to answer the wrong question.
 *
 * Incident: field reports of an MCP link that never works and a daemon that restarts without end —
 * one local daemon log holds 760 `reticle_daemon_ready` against 759
 * `reticle_daemon_previous_died_unclean`, a spawn/die loop running for a month. The wake path
 * (`mcp-command.ts`) spawns a daemon and then waits for it with this function, which polled a bare
 * TCP connect. A daemon wedged mid-start accepts connections and never serves, so the wait returned
 * READY, the proxy dialled a corpse, and the cycle repeated.
 *
 * `cli.ts` already knew: its `ensureDaemon` carries a comment saying `waitForDaemon` "would then
 * report READY anyway, because its probe is the same bare TCP connect", and guards ITS OWN call
 * ahead of time. The wake path has no such guard, and a guard per caller was never the fix — the
 * shared function was.
 */
import { describe, expect, it } from 'vitest';
import { waitForDaemon, waitForDaemonBind } from './proxy-daemon-probe.js';

const PORT = 4400;

describe('waitForDaemon', () => {
  it('does not report ready for a port that accepts connections but serves no status', async () => {
    await expect(
      waitForDaemon(PORT, {
        tcpOpen: () => Promise.resolve(true),
        status: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  it('reports ready once the daemon answers status', async () => {
    let asked = 0;
    await expect(
      waitForDaemon(PORT, {
        tcpOpen: () => Promise.resolve(true),
        status: () => Promise.resolve(++asked > 1 ? { ok: true } : undefined),
      }),
    ).resolves.toBeUndefined();
    expect(asked).toBeGreaterThan(1);
  });

  it('says what was actually on the port when it gives up', async () => {
    await expect(
      waitForDaemon(PORT, {
        tcpOpen: () => Promise.resolve(true),
        status: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow(/held by/);
  });

  // A daemon that dies while it starts never serves. The wait polled its port for the full timeout,
  // and the tool call behind it waited too.
  it('gives up at once when the daemon process it waits for has exited', async () => {
    let probes = 0;
    await expect(
      waitForDaemon(PORT, {
        tcpOpen: () => {
          probes++;
          return Promise.resolve(false);
        },
        status: () => Promise.resolve(undefined),
        alive: () => false,
      }),
    ).rejects.toThrow(/exited before it was ready/);
    expect(probes, 'no poll after the process is gone').toBe(1);
  });
});

/**
 * #1541: on Windows under load the daemon can need longer than the old fixed 15 s bind
 * deadline — a `--drive` Chromium launch runs before the daemon binds — so `serve` reported
 * "the daemon did not come up" and exited 1 over a child that bound seconds later and kept
 * running, unnamed. The wait must track the CHILD: keep waiting while it is alive up to a
 * longer ceiling, and stop at once when it died, because a dead child will never bind.
 */
describe('waitForDaemonBind', () => {
  it('reports a child that binds late as started, past the old deadline shape', async () => {
    let probes = 0;
    const bound = await waitForDaemonBind(PORT, {
      timeoutMs: 60_000,
      pollMs: 1,
      childAlive: () => true,
      probes: {
        tcpOpen: () => Promise.resolve(++probes > 30),
        status: () => Promise.resolve({ ok: true }),
      },
    });
    expect(bound).toBe(true);
    expect(probes).toBeGreaterThan(30);
  });

  it('stops waiting at once when the child died, without riding out the ceiling', async () => {
    let aliveChecks = 0;
    const bound = await waitForDaemonBind(PORT, {
      timeoutMs: 60_000,
      pollMs: 1,
      childAlive: () => ++aliveChecks < 3,
      probes: {
        tcpOpen: () => Promise.resolve(false),
        status: () => Promise.resolve(undefined),
      },
    });
    expect(bound).toBe(false);
    expect(aliveChecks).toBeLessThan(10);
  });

  it('gives up at the ceiling while the child is still alive', async () => {
    const bound = await waitForDaemonBind(PORT, {
      timeoutMs: 40,
      pollMs: 1,
      childAlive: () => true,
      probes: {
        tcpOpen: () => Promise.resolve(false),
        status: () => Promise.resolve(undefined),
      },
    });
    expect(bound).toBe(false);
  });
});

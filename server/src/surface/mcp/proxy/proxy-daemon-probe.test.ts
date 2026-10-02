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
import { waitForDaemon } from './proxy-daemon-probe.js';

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
});

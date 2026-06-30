/**
 * The daemon survives a stray async rejection (one agent's error can't crash the fleet) but exits
 * cleanly on a genuine uncaught synchronous throw (so it can be respawned fresh).
 */

import { describe, expect, it } from 'vitest';
import { installDaemonResilience, type ProcessLike } from './daemon-resilience.js';

/** A fake process that records listeners and lets the test emit events. */
function fakeProc(): ProcessLike & { emit: (event: string, arg: unknown) => void } {
  const listeners = new Map<string, (arg: unknown) => void>();
  return {
    on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    emit(event, arg) {
      listeners.get(event)?.(arg);
    },
  };
}

describe('installDaemonResilience', () => {
  it('logs an unhandled rejection and KEEPS running (no fatal exit)', () => {
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    let fatal = 0;
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      (event, data) => logs.push({ event, data }),
      () => (fatal += 1),
    );

    proc.emit('unhandledRejection', new Error('one agent blew up'));

    expect(fatal).toBe(0); // the daemon stays alive for the other agents
    expect(logs).toHaveLength(1);
    expect(logs[0]?.event).toBe('reticle_daemon_unhandled_rejection');
    expect(logs[0]?.data['reason']).toBe('one agent blew up');
  });

  it('logs an uncaught exception and exits cleanly (respawnable)', () => {
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    let fatal = 0;
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      (event, data) => logs.push({ event, data }),
      () => (fatal += 1),
    );

    proc.emit('uncaughtException', new Error('truly unexpected'));

    expect(fatal).toBe(1); // exit so the next `reticle mcp` respawns a fresh daemon
    expect(logs[0]?.event).toBe('reticle_daemon_uncaught_exception');
    expect(logs[0]?.data['error']).toBe('truly unexpected');
  });

  it('stringifies non-Error reasons safely', () => {
    const logs: Record<string, unknown>[] = [];
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      (_e, data) => logs.push(data),
      () => undefined,
    );
    proc.emit('unhandledRejection', 'a string rejection');
    expect(logs[0]?.['reason']).toBe('a string rejection');
  });
});

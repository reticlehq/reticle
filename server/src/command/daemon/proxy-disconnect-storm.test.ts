/**
 * A proxy whose client is gone must leave, not spin.
 *
 * "Absorb the disconnect and keep serving" is right for one disconnect — the client closed a socket
 * and the proxy rebuilds it. It is catastrophic for a stream of them: the write that failed is
 * retried at once, fails identically, and is absorbed again, with no backoff and no exit.
 *
 * Unbounded, a `reticle mcp` outlives the editor that launched it by days, pinning a core and
 * writing identical `client_disconnected` lines stamped to the same millisecond. Nothing in
 * Reticle's own output shows it — the daemon beside it reports healthy with `sessions: 0` — so it is
 * findable only by running `ps` by hand.
 */
import { describe, expect, it } from 'vitest';
import { installProxyResilience } from './daemon-resilience.js';

type Listener = (arg: unknown) => void;

class FakeProc {
  readonly #listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }
}

const errno = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });

interface Wired {
  proc: FakeProc;
  exits: number;
  events: string[];
  noteUsableSession: () => void;
}

function wire(): Wired {
  const proc = new FakeProc();
  const out: Wired = { proc, exits: 0, events: [], noteUsableSession: () => undefined };
  const handle = installProxyResilience(
    proc,
    (event) => out.events.push(event),
    () => undefined,
    () => {
      out.exits += 1;
    },
  );
  out.noteUsableSession = () => handle.noteUsableSession();
  return out;
}

const STORM = 20;

describe('the proxy leaves once its client is gone for good', () => {
  it('keeps serving through the handful a real reconnect produces', () => {
    const w = wire();
    for (let i = 0; i < STORM - 1; i += 1) w.proc.emit('uncaughtException', errno('EPIPE'));
    expect(w.exits, 'one client leaving and coming back must not kill the proxy').toBe(0);
  });

  it('exits when the disconnects keep coming', () => {
    const w = wire();
    for (let i = 0; i < STORM; i += 1) w.proc.emit('uncaughtException', errno('EPIPE'));
    expect(w.exits).toBe(1);
    expect(w.events.at(-1)).toBe('reticle_mcp_proxy_client_gone');
  });

  it('exits once, however long the loop runs — the log must not become the leak', () => {
    const w = wire();
    for (let i = 0; i < STORM * 50; i += 1) w.proc.emit('uncaughtException', errno('EPIPE'));
    expect(w.exits, 'a second exit call is a second storm of its own').toBe(1);
    expect(w.events.filter((e) => 'reticle_mcp_proxy_client_gone' === e)).toHaveLength(1);
    // Every emit here is a synchronous in-memory call, but the loop reads as heavy to the guard that
    // requires a declared bound — and a declared bound is the right answer to that either way.
  }, 15_000);

  it('counts rejections and exceptions as the same client leaving', () => {
    const w = wire();
    for (let i = 0; i < STORM; i += 1) {
      w.proc.emit(0 === i % 2 ? 'uncaughtException' : 'unhandledRejection', errno('ECONNRESET'));
    }
    expect(w.exits).toBe(1);
  });

  it('never exits on a daemon that has not booted yet — nobody went away', () => {
    const w = wire();
    for (let i = 0; i < STORM * 5; i += 1) {
      w.proc.emit('unhandledRejection', errno('ECONNREFUSED'));
    }
    expect(w.exits, 'the proxy is BUILT to tolerate a cold daemon and wake it').toBe(0);
  });

  it('never exits on a real crash, which is reported and survived', () => {
    const w = wire();
    for (let i = 0; i < STORM * 5; i += 1) {
      w.proc.emit('uncaughtException', new Error('a genuine bug'));
    }
    expect(w.exits).toBe(0);
  });
});

/**
 * A disconnect counted over a LIFETIME is a different measurement from a disconnect storm.
 *
 * THE DEFECT THIS EXISTS FOR: `disconnects` was declared once and never reset, so twenty
 * disconnects spread over days reached the same threshold as twenty in eight seconds, and the
 * proxy exited on a working week. The classifier it feeds on treats `ECONNRESET` as "the peer
 * vanished", and on the proxy's leg to `127.0.0.1:<daemon>` the peer IS the daemon -- the thing the
 * proxy exists to survive, and a thing that restarts routinely. Confirmed by reading the counter
 * and the daemon-start count on one machine over four days, on 2026-09-21.
 *
 * Reaching an `endpoint` frame is the signal that already earns a fresh RETRY budget in
 * mcp-proxy.ts, for the same reason: it is the one event that proves a usable session, rather than
 * a set of response headers a broken daemon also produces. The storm counter now clears on it too,
 * so the threshold measures a runaway instead of an uptime.
 */
describe('a usable session clears the storm counter', () => {
  it('does not exit when disconnects are separated by a working session', () => {
    const w = wire();
    for (let i = 0; i < 19; i += 1) w.proc.emit('unhandledRejection', errno('ECONNRESET'));
    expect(w.exits).toBe(0);
    w.noteUsableSession();
    // Another nineteen, which without the reset would be thirty-eight and long past the threshold.
    for (let i = 0; i < 19; i += 1) w.proc.emit('unhandledRejection', errno('ECONNRESET'));
    expect(w.exits).toBe(0);
  });

  it('still exits on a genuine storm, with no usable session between', () => {
    const w = wire();
    for (let i = 0; i < 25; i += 1) w.proc.emit('unhandledRejection', errno('ECONNRESET'));
    expect(w.exits).toBeGreaterThan(0);
    expect(w.events).toContain('reticle_mcp_proxy_client_gone');
  });

  it('a reset after the proxy has already left does not bring it back', () => {
    const w = wire();
    for (let i = 0; i < 25; i += 1) w.proc.emit('unhandledRejection', errno('ECONNRESET'));
    const exits = w.exits;
    w.noteUsableSession();
    for (let i = 0; i < 25; i += 1) w.proc.emit('unhandledRejection', errno('ECONNRESET'));
    expect(w.exits).toBe(exits);
  });
});

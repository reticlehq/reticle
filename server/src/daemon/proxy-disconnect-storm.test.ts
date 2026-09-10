/**
 * A proxy whose client is gone must leave, not spin.
 *
 * "Absorb the disconnect and keep serving" is right for one disconnect — the client closed a socket
 * and the proxy rebuilds it. It is catastrophic for a stream of them: the write that failed is
 * retried at once, fails identically, and is absorbed again, with no backoff and no exit.
 *
 * Measured in the field: one `reticle mcp` ran four days after its editor closed, at 97-98% of a
 * core, 1473 minutes of CPU time, writing ~930 MB/hour of identical `client_disconnected` lines all
 * stamped to the same millisecond. Nothing in Reticle's own output showed it — the daemon beside it
 * reported healthy with `sessions: 0` — so it was findable only by running `ps` by hand, with
 * thirteen more resident pairs from earlier sessions behind it.
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
}

function wire(): Wired {
  const proc = new FakeProc();
  const out: Wired = { proc, exits: 0, events: [] };
  installProxyResilience(
    proc,
    (event) => out.events.push(event),
    () => undefined,
    () => {
      out.exits += 1;
    },
  );
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

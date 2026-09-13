/**
 * The daemon survives a stray async rejection (one agent's error can't crash the fleet) but exits
 * cleanly on a genuine uncaught synchronous throw (so it can be respawned fresh).
 */

import { describe, expect, it } from 'vitest';
import {
  CrashKind,
  installDaemonResilience,
  installProxyResilience,
  type ProcessLike,
} from './daemon-resilience.js';

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

/**
 * The proxy's rule is the OPPOSITE of the daemon's, and the difference is who can restart it.
 *
 * A daemon that exits on an uncaught throw is respawned by the next `reticle mcp`, so exiting is the
 * safe answer there. Nothing respawns the PROXY: it is the stdio MCP server the editor launched, and
 * when it exits the client marks the server disconnected, drops its tools, and waits for a human to
 * open /mcp and reconnect. Staying up with a logged error is strictly better than that, because the
 * proxy's own state is a socket and a queue — both of which it already knows how to rebuild.
 */
/**
 * A client going away is not a crash.
 *
 * One real session produced NINE `runtime_crashed` events, every one of them `write EPIPE`: the MCP
 * client closed its end of the stdio pipe and the next `process.stdout.write` failed, exactly as it
 * is supposed to. Reported as uncaught exceptions they poison the one metric that answers "is
 * Reticle stable?", and they would have kept doing it every time an editor was closed.
 *
 * Recognised by ERROR CODE, never by message text — a message is localised, wrapped and rewritten;
 * `err.code` is Node's contract.
 */
describe('an expected disconnect is logged, never counted as a crash', () => {
  function epipe(code: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`write ${code}`);
    err.code = code;
    return err;
  }

  it.each(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'])(
    '%s on the daemon is logged and does NOT kill the daemon',
    (code) => {
      const logs: { event: string; data: Record<string, unknown> }[] = [];
      let fatal = 0;
      const proc = fakeProc();
      installDaemonResilience(
        proc,
        (event, data) => logs.push({ event, data }),
        () => (fatal += 1),
      );

      proc.emit('uncaughtException', epipe(code));

      expect(fatal, 'one client leaving must not take the fleet down').toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.event).toBe('reticle_daemon_client_disconnected');
      expect(logs[0]?.data['code']).toBe(code);
    },
  );

  it('is still VISIBLE on the proxy, just not reported as a crash', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    const crashes: CrashKind[] = [];
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      (kind) => crashes.push(kind),
    );

    proc.emit('uncaughtException', epipe('EPIPE'));
    proc.emit('unhandledRejection', epipe('EPIPE'));

    expect(crashes).toEqual([]);
    expect(lines.map((l) => l.event)).toEqual([
      'reticle_mcp_proxy_client_disconnected',
      'reticle_mcp_proxy_client_disconnected',
    ]);
  });

  /** The over-filtering guard: a genuine crash must still be reported, and still be fatal. */
  it('a real uncaught exception is still a crash', () => {
    const proc = fakeProc();
    const crashes: CrashKind[] = [];
    installProxyResilience(
      proc,
      () => undefined,
      (kind) => crashes.push(kind),
    );
    proc.emit('uncaughtException', new Error('undefined is not a function'));
    expect(crashes).toEqual([CrashKind.UNCAUGHT_EXCEPTION]);
  });

  it('an error whose MESSAGE says EPIPE but carries no code is still a crash', () => {
    const proc = fakeProc();
    let fatal = 0;
    const logs: string[] = [];
    installDaemonResilience(
      proc,
      (event) => logs.push(event),
      () => (fatal += 1),
    );
    proc.emit('uncaughtException', new Error('write EPIPE'));
    expect(fatal, 'text is not evidence — only err.code is').toBe(1);
    expect(logs).toEqual(['reticle_daemon_uncaught_exception']);
  });

  it('an unrelated errno (ENOENT) is still a crash', () => {
    const proc = fakeProc();
    let fatal = 0;
    installDaemonResilience(
      proc,
      () => undefined,
      () => (fatal += 1),
    );
    proc.emit('uncaughtException', epipe('ENOENT'));
    expect(fatal).toBe(1);
  });
});

describe('installProxyResilience — the MCP server must outlive its own bugs', () => {
  it('logs an uncaught exception and KEEPS SERVING — exiting would disconnect the client', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    const crashes: CrashKind[] = [];
    // There is no fatal hook to pass: the signature cannot express "and then exit", which is the
    // point. The daemon's equivalent takes one and uses it; the proxy has nobody to respawn it.
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      (kind) => crashes.push(kind),
    );
    proc.emit('uncaughtException', new Error('a bug in the proxy'));
    expect(lines.some((l) => l.event.includes('uncaught'))).toBe(true);
    expect(crashes, 'still reported, just not fatal').toEqual([CrashKind.UNCAUGHT_EXCEPTION]);
  });

  it('logs an unhandled rejection and keeps serving', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      () => undefined,
    );
    proc.emit('unhandledRejection', 'a stray promise');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toContain('proxy');
  });
});

/**
 * A refused connect is not a crash.
 *
 * In the field **every `runtime_crashed` event carried one fingerprint** —
 * `connect ECONNREFUSED`, `unhandled_rejection`, actor `agent`. The proxy is designed to tolerate a
 * daemon that has not booted: it serves the catalog from cache and wakes one on the next request. So
 * the crash metric spent two days reporting a designed, recovered-from condition, which is the same
 * as having no crash metric at all.
 */
describe('a daemon that is not up yet is not a crash', () => {
  function errno(code: string, message: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(message);
    err.code = code;
    return err;
  }

  it('ECONNREFUSED on the proxy is logged as unreachable and NOT reported as a crash', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    const crashes: CrashKind[] = [];
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      (kind) => crashes.push(kind),
    );

    proc.emit('unhandledRejection', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4400'));

    expect(crashes, 'the whole point: this must not inflate runtime_crashed').toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('reticle_mcp_proxy_daemon_unreachable');
    expect(lines[0]?.data['code']).toBe('ECONNREFUSED');
  });

  it('ECONNREFUSED on the daemon is absorbed too, and never fatal', () => {
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    let fatal = 0;
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      (event, data) => logs.push({ event, data }),
      () => (fatal += 1),
    );

    proc.emit('uncaughtException', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4400'));

    expect(fatal).toBe(0);
    expect(logs[0]?.event).toBe('reticle_daemon_peer_unreachable');
  });

  it('is still VISIBLE — absorbed means reclassified, never silenced', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      () => undefined,
    );

    proc.emit('unhandledRejection', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4400'));

    expect(lines, 'a hundred of these in a session is a finding, not noise').toHaveLength(1);
    expect(String(lines[0]?.data['note'])).toContain('not a crash');
  });

  it('does not confuse the two classes: a disconnect keeps its own event name', () => {
    const proc = fakeProc();
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    installProxyResilience(
      proc,
      (event, data) => lines.push({ event, data }),
      () => undefined,
    );

    proc.emit('unhandledRejection', errno('ECONNRESET', 'read ECONNRESET'));

    expect(lines[0]?.event).toBe('reticle_mcp_proxy_client_disconnected');
  });

  it('an error whose MESSAGE says ECONNREFUSED but carries no code is still a crash', () => {
    const proc = fakeProc();
    const crashes: CrashKind[] = [];
    installProxyResilience(
      proc,
      () => undefined,
      (kind) => crashes.push(kind),
    );

    proc.emit('unhandledRejection', new Error('connect ECONNREFUSED 127.0.0.1:4400'));

    expect(crashes, 'matching on prose would absorb real bugs that mention a port').toEqual([
      CrashKind.UNHANDLED_REJECTION,
    ]);
  });
});

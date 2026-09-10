import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashPort, TelemetryEventKind } from '@reticlehq/core/telemetry';
import type { TelemetryExtra } from '../telemetry/telemetry.js';

const emit = vi.fn((_kind: TelemetryEventKind, _extra?: TelemetryExtra) => Promise.resolve(true));
vi.mock('../telemetry/telemetry.js', () => ({
  getTelemetry: () => ({ emit, enabled: true, firstRun: false }),
}));

const { installDaemonResilience } = await import('./daemon-resilience.js');
type ProcessLike = Parameters<typeof installDaemonResilience>[0];

function fakeProc(): ProcessLike & { fire: (event: string, arg: unknown) => void } {
  const listeners = new Map<string, (arg: unknown) => void>();
  return {
    on(event: string, handler: (arg: unknown) => void) {
      listeners.set(event, handler);
      return this;
    },
    fire(event, arg) {
      listeners.get(event)?.(arg);
    },
  };
}

/**
 * A loopback connect that failed on a system error: the shape that arrives with `frames: []` and
 * nothing else.
 *
 * `EHOSTUNREACH`, not `ECONNREFUSED`, and the difference is the point. This file originally used a
 * refused connect, which was the right example when it was written — 65 such crashes in a day, one
 * fingerprint, no location on any of them. In the same release, `ECONNREFUSED` stopped being a
 * crash at all: it is a daemon that has not booted yet, the proxy is built to tolerate it, and all
 * every crash event over two days was that one non-crash. It is now absorbed as
 * `*_peer_unreachable` before it ever reaches `reportCrash`.
 *
 * So the enrichment this file tests still matters, for exactly the crashes that ARE crashes and
 * still had no location. Same code path, same assertions, an example that still reaches it.
 * `daemon-resilience.test.ts` covers the absorbed case.
 */
function refusedLoopback(port: number): Error {
  const error = Object.assign(new Error(`connect EHOSTUNREACH 127.0.0.1:${String(port)}`), {
    syscall: 'connect',
    code: 'EHOSTUNREACH',
    address: '127.0.0.1',
    port,
  });
  error.stack = `Error: connect EHOSTUNREACH 127.0.0.1:${String(port)}\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)`;
  return error;
}

function crashOf(extra: TelemetryExtra | undefined): Record<string, unknown> {
  return { ...extra?.crash };
}

describe('a crash with no Reticle frames still reports where it was', () => {
  beforeEach(() => {
    emit.mockClear();
  });

  it('carries the syscall, the errno, the loopback bit and a node frame', () => {
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      () => undefined,
      () => undefined,
    );
    proc.fire('unhandledRejection', refusedLoopback(4400));

    const call = emit.mock.calls.find(([kind]) => kind === TelemetryEventKind.RUNTIME_CRASHED);
    expect(call).toBeDefined();
    const crash = crashOf(call?.[1]);

    // The defect, reproduced: this is what the report used to be, and all it used to be.
    expect(crash['frames']).toEqual([]);

    expect(crash['syscall']).toBe('connect');
    expect(crash['errno']).toBe('EHOSTUNREACH');
    expect(crash['loopback']).toBe(true);
    expect(crash['port']).toBe(CrashPort.RETICLE);
    expect(crash['internalFrame']).toBe('node:net:1637');
  });

  it('never sends the address or the port number', () => {
    const proc = fakeProc();
    installDaemonResilience(
      proc,
      () => undefined,
      () => undefined,
    );
    proc.fire('unhandledRejection', refusedLoopback(4400));

    const call = emit.mock.calls.find(([kind]) => kind === TelemetryEventKind.RUNTIME_CRASHED);
    const serialized = JSON.stringify(crashOf(call?.[1]));
    expect(serialized).not.toContain('127.0.0.1');
    // The message is skeletonised, so the port survives nowhere — not in a field, not in prose.
    expect(serialized).not.toContain('4400');
  });
});

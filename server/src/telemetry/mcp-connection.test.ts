/**
 * WHICH agent attached — the field that was defined, documented and never once populated.
 *
 * The only caller reported the connect from `transport.connect().then(...)`, which resolves when the
 * SSE stream opens: before the client has said who it is. `clientInfo` exists from `oninitialized`
 * and nowhere earlier, so the event carried every fact about the connection except the one that
 * makes "which client converts best" answerable at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { markDaemonStart, reportMcpConnected, resetMcpConnections } from './mcp-connection.js';
import { getTelemetry } from './telemetry.js';

beforeEach(() => {
  resetMcpConnections();
  markDaemonStart(1_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMcpConnections();
});

function connections(): () => Record<string, unknown>[] {
  const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
  return () =>
    emit.mock.calls
      .filter((call) => TelemetryEventKind.MCP_CLIENT_CONNECTED === call[0])
      .map((call) => (call[1] as { connection: Record<string, unknown> }).connection);
}

describe('reportMcpConnected', () => {
  it('carries the name the client gave at its handshake', () => {
    const seen = connections();
    reportMcpConnected('claude-code', undefined, () => 2_000);
    expect(seen()[0]).toMatchObject({
      client: 'claude-code',
      reconnect: false,
      daemonAgeMs: 1_000,
    });
  });

  /**
   * A stream that opens and never handshakes is a probe, not a client: the transport attach knows
   * nothing about who is on the other end, and reporting it as a connection is what put an
   * unattributable row in the place the name was meant to be.
   */
  it('says nothing for an attach that never named itself', () => {
    const seen = connections();
    reportMcpConnected();
    expect(seen()).toEqual([]);
  });

  it('counts reconnect churn over named connects only', () => {
    const seen = connections();
    reportMcpConnected('cursor', 'proxy-a', () => 2_000);
    reportMcpConnected();
    reportMcpConnected('cursor', 'proxy-b', () => 3_000);
    expect(seen().map((connection) => connection['reconnect'])).toEqual([false, true]);
  });

  it('reports a proxy once, not again when the same proxy reconnects', () => {
    const seen = connections();
    reportMcpConnected('cursor', 'proxy-a', () => 2_000);
    reportMcpConnected('cursor', 'proxy-a', () => 3_000);
    reportMcpConnected('cursor', 'proxy-a', () => 4_000);
    expect(seen()).toHaveLength(1);
  });

  it('carries the proxy id, the key that joins an outage to this daemon run', () => {
    const seen = connections();
    reportMcpConnected('cursor', 'proxy-a', () => 2_000);
    expect(seen()[0]?.['proxyId']).toBe('proxy-a');
  });

  it('caps a client name to the wire limit, so the event is not dropped as invalid', () => {
    const seen = connections();
    reportMcpConnected('x'.repeat(500), undefined, () => 2_000);
    expect(String(seen()[0]?.['client']).length).toBe(64);
  });
});

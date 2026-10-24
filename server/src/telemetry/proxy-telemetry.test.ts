/**
 * POST socket failures are invisible to the two events that look like they would catch them:
 * `tool_refused` never fires (the handler never ran) and `mcp_connection_lost` never fires (the SSE
 * stream is fine). The counts therefore ride the existing session summary, omitted when zero.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyExitReason, TelemetryEventKind, WakeRefusalPresence } from '@reticlehq/core';
import { SessionMetrics } from './session-metrics.js';
import { createTelemetry } from './telemetry.js';
import {
  flushProxySessionMetrics,
  noteProxyDrop,
  noteProxyToolCall,
  reportDaemonDiedUnclean,
  PROXY_ID,
  reportProxyExited,
  reportWakeRefused,
  resetProxyExitReporting,
} from './proxy-telemetry.js';

const TEST_ENV = {
  RETICLE_TELEMETRY_KEY: 'phc_test',
  RETICLE_TELEMETRY_URL: 'http://example.test',
};

const USER_PROJECT = '/tmp/some-user-app';

interface CapturedBatch {
  batch: Array<{ event: string; properties: Record<string, unknown> }>;
}

describe('socket-level POST failures are countable on the session summary', () => {
  it('counts a failure and a retry that then delivered, and omits both when none happened', () => {
    const m = new SessionMetrics(() => 0);
    expect(m.summarize(true).postSocketFailures).toBeUndefined();
    expect(m.summarize(true).postRetriesSaved).toBeUndefined();
    m.recordPostSocketFailure();
    m.recordPostRetrySaved();
    const s = m.summarize(true);
    expect(s.postSocketFailures).toBe(1);
    expect(s.postRetriesSaved).toBe(1);
  });

  it('an idle rollup is empty so a proxy that never hit the socket does not emit', () => {
    expect(new SessionMetrics(() => 0).empty).toBe(true);
  });

  it('a rollup with only socket failures is not empty — that is the whole signal', () => {
    const m = new SessionMetrics(() => 0);
    m.recordPostSocketFailure();
    expect(m.empty).toBe(false);
  });
});

describe('the proxy flushes those counts on an existing event, and awaits the send', () => {
  it('emits session_progress with session_postSocketFailures on the wire', async () => {
    const calls: CapturedBatch[] = [];
    const fetchImpl = ((_url: string, init: { body?: string }) => {
      calls.push(JSON.parse(init.body ?? '{}') as CapturedBatch);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const telemetry = createTelemetry({
      version: '9.9.9',
      env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
      fetchImpl,
      cwd: USER_PROJECT,
    });
    const metrics = new SessionMetrics(() => 0);
    metrics.recordPostSocketFailure();
    metrics.recordPostRetrySaved();
    await flushProxySessionMetrics(telemetry, metrics);
    expect(calls).toHaveLength(1);
    const properties = calls[0]?.batch[0]?.properties ?? {};
    expect(calls[0]?.batch[0]?.event).toBe(TelemetryEventKind.SESSION_PROGRESS);
    expect(properties.session_postSocketFailures, 'the count was dropped').toBe(1);
    expect(properties.session_postRetriesSaved, 'the saved-retry count was dropped').toBe(1);
    // A session_progress is a window. Sending the FINAL summary here restated the lifetime totals
    // on a row that every query sums.
    expect(properties.session_final).toBe(false);
    expect(properties.session_lifetimeToolCalls).toBeUndefined();
  });

  it('emits nothing when the proxy never saw a socket failure', async () => {
    let sent = 0;
    const fetchImpl = (() => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const telemetry = createTelemetry({
      version: '9.9.9',
      env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
      fetchImpl,
      cwd: USER_PROJECT,
    });
    await flushProxySessionMetrics(telemetry, new SessionMetrics(() => 0));
    expect(sent).toBe(0);
  });
});

/**
 * The transport events the proxy and the daemon start send. Each block must reach the wire: `emit`
 * builds its event from an explicit list of keys, and a block missing from that list is dropped with
 * no error. That is how `outage` was lost for months.
 */
describe('the proxy exit, unclean death and wake refusal reach the wire', () => {
  function recording(): { telemetry: ReturnType<typeof createTelemetry>; calls: CapturedBatch[] } {
    const calls: CapturedBatch[] = [];
    const fetchImpl = ((_url: string, init: { body?: string }) => {
      calls.push(JSON.parse(init.body ?? '{}') as CapturedBatch);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const telemetry = createTelemetry({
      version: '9.9.9',
      env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
      fetchImpl,
      cwd: USER_PROJECT,
    });
    return { telemetry, calls };
  }

  afterEach(() => resetProxyExitReporting());

  it('sends mcp_proxy_exited with its counts, once, and awaits the send', async () => {
    const { telemetry, calls } = recording();
    noteProxyDrop();
    noteProxyToolCall();
    noteProxyToolCall();
    await reportProxyExited(ProxyExitReason.IDLE, telemetry, 1234);
    await reportProxyExited(ProxyExitReason.STDIN_END, telemetry, 1300);
    expect(calls).toHaveLength(1);
    const event = calls[0]?.batch[0];
    expect(event?.event).toBe(TelemetryEventKind.MCP_PROXY_EXITED);
    expect(event?.properties.proxyExit_reason).toBe(ProxyExitReason.IDLE);
    expect(event?.properties.proxyExit_uptimeMs).toBe(1234);
    expect(event?.properties.proxyExit_drops).toBe(1);
    expect(event?.properties.proxyExit_toolCalls).toBe(2);
  });

  it('names the proxy process, so its exit joins its outages and its daemon run', async () => {
    const { telemetry, calls } = recording();
    await reportProxyExited(ProxyExitReason.IDLE, telemetry, 1234);
    expect(calls[0]?.batch[0]?.properties.proxyExit_proxyId).toBe(PROXY_ID);
  });

  it('sends daemon_died_unclean with the age of the dead daemon', async () => {
    const { telemetry, calls } = recording();
    await reportDaemonDiedUnclean(60_000, telemetry);
    expect(calls[0]?.batch[0]?.event).toBe(TelemetryEventKind.DAEMON_DIED_UNCLEAN);
    expect(calls[0]?.batch[0]?.properties.daemonDeath_ageMs).toBe(60_000);
  });

  it('sends wake_refused once per process, naming what held the port', async () => {
    const { telemetry, calls } = recording();
    await reportWakeRefused(WakeRefusalPresence.OTHER_PROJECT, telemetry);
    await reportWakeRefused(WakeRefusalPresence.FOREIGN, telemetry);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.batch[0]?.event).toBe(TelemetryEventKind.WAKE_REFUSED);
    expect(calls[0]?.batch[0]?.properties.wakeRefusal_presence).toBe(
      WakeRefusalPresence.OTHER_PROJECT,
    );
  });
});

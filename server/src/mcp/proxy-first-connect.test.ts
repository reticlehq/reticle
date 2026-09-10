/**
 * The first bootstrap on a machine, reported from Windows: `reticle mcp` announced
 * `reticle_mcp_daemon_started` on 4400, was unavailable about ten seconds later, and the very first
 * `reticle_sessions` expired with -32001. The trace is one refused connect, the local handshake, and
 * a queued request nobody ever came back for.
 *
 * The first connect got exactly ONE attempt. A refusal at that moment is not a failure, it is a
 * daemon that has not finished booting — and on a first-run Windows machine that takes longer than
 * the window allowed. Nothing retried, because only a fresh CLIENT request re-probes the port, and
 * the client was already waiting on the call that was about to expire.
 */

import { describe, expect, it } from 'vitest';
import { QUEUE_WAIT_MS, shouldRetryFirstConnect, queueExpiryNextStep } from './mcp-proxy.js';

const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4400'), {
  code: 'ECONNREFUSED',
});

describe('first connect', () => {
  it('retries a refused port instead of reporting a startup failure', () => {
    expect(shouldRetryFirstConnect(refused, 0)).toBe(true);
  });

  it('keeps chasing for longer than the queue would wait', () => {
    // The point of the window: a daemon that arrives late must still be found, or the retry stops
    // before the request it would have rescued has even been answered.
    expect(shouldRetryFirstConnect(refused, QUEUE_WAIT_MS)).toBe(true);
  });

  it('gives up eventually rather than chasing a port nothing will ever serve', () => {
    expect(shouldRetryFirstConnect(refused, 10 * 60_000)).toBe(false);
  });

  it('does not retry a failure that is not a port still coming up', () => {
    const denied = Object.assign(new Error('connect EACCES'), { code: 'EACCES' });
    expect(shouldRetryFirstConnect(denied, 0)).toBe(false);
    expect(shouldRetryFirstConnect(new Error('socket hang up'), 0)).toBe(false);
    expect(shouldRetryFirstConnect(null, 0)).toBe(false);
  });
});

describe('queue expiry message', () => {
  /**
   * `-32001` on the first call after an install tells the user nothing at all — not whether to wait,
   * retry, or start over.
   */
  it('names the port and a command the reader can actually run', () => {
    const step = queueExpiryNextStep(4400);
    expect(step).toContain('4400');
    expect(step).toContain('reticle doctor');
    expect(step).toContain('Retry the call');
  });
});

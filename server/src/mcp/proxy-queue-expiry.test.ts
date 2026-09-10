/**
 * A proxy that gave up must still be able to find a daemon that arrives afterwards.
 *
 * The reported sequence, at the first two minutes of a first-ever setup: the daemon came up wedged
 * (listening, never serving SSE), the proxy spent its reconnect budget against it, and every MCP call
 * from then on returned −32001. The human killed the wedged process and started a healthy daemon on
 * the same port by hand. The proxy still returned −32001 to every call. The only remaining fix was
 * reloading the MCP server in the IDE, which no agent can do for itself.
 *
 * The state machine is why. `WAKE` clears `dormant` and starts a reconnect. A wedged port accepts the
 * socket and then does nothing, so that reconnect neither resolves nor rejects and `dormant` stays
 * false — permanently. Every later request reads as "a reconnect is already in flight" and QUEUEs,
 * the queue expires, the request is answered with a failure, and nothing ever re-probes the port.
 *
 * Expiring the queue is exactly the evidence that the in-flight reconnect is not coming, so it is the
 * right moment to go dormant and let the next request look again.
 */

import { describe, expect, it } from 'vitest';
import { OnDrop, OnRequest, onQueueExpired, onClientRequest } from './proxy-lifecycle.js';

describe('queue expiry', () => {
  it('goes dormant rather than staying in a reconnect that will never land', () => {
    expect(onQueueExpired()).toBe(OnDrop.DORMANT);
  });

  it('is what turns the next client request back into a re-probe', () => {
    // Before: WAKE cleared dormant, the reconnect hung, and every later request queued forever.
    const stuck = onClientRequest(false, false);
    expect(stuck).toBe(OnRequest.QUEUE);

    // After: the expiry sets dormant, so the very next request wakes and probes the port again —
    // which is the only path that can discover the healthy daemon the human just started.
    const dormant = OnDrop.DORMANT === onQueueExpired();
    expect(onClientRequest(false, dormant)).toBe(OnRequest.WAKE);
  });

  it('never overrides a live connection', () => {
    // A connected proxy posts straight through no matter what the expiry decided.
    expect(onClientRequest(true, true)).toBe(OnRequest.SEND);
  });
});

/**
 * When the proxy may start a daemon — the rule that keeps an idle install from looping forever.
 *
 * Two changes collided to produce a real regression, and this is the seam that prevents it coming
 * back. A daemon may now shut itself down when it has served nothing and no browser ever connected
 * (see daemon-usefulness.ts). The proxy separately learned to respawn a dead daemon, because one
 * that crashed or was stopped used to take the agent's whole Reticle surface with it. Together they
 * loop: the daemon exits as useless, the proxy immediately brings back a daemon that is equally
 * useless, which exits, forever. Measured with a 4s grace: four processes in 200 seconds. At the
 * real 300s grace that is a new process every five minutes for the many installs that never call a
 * tool, for as long as the editor is open.
 *
 * The rule that resolves it: a dropped stream is not demand. Reattach to a daemon that is already
 * there; otherwise go dormant and let the next thing the CLIENT asks for bring Reticle back.
 *
 * Extracted as pure functions because the decision used to live inside a closure where no test could
 * reach it — and a guard that re-implements the decision instead of calling it is insensitive to the
 * thing it claims to guard.
 */

import { PortPresence } from '../daemon/port-presence.js';

/** What to do when the SSE stream drops. */
export const OnDrop = {
  /** A daemon is listening — reattach to it. */
  REATTACH: 'reattach',
  /** Nothing is listening. Do NOT spawn: wait to be needed. */
  DORMANT: 'dormant',
} as const;
export type OnDrop = (typeof OnDrop)[keyof typeof OnDrop];

/**
 * A stream drop only ever justifies reattaching, never spawning. This is the whole fix: the proxy
 * used to spawn here, which turned a daemon's own idle shutdown into a permanent respawn loop.
 *
 * It takes the PRESENCE, not a boolean. It used to take `daemonListening`, filled from a bare TCP
 * connect — a probe that cannot tell a Reticle daemon from anything else that accepts a socket. A
 * stranger on the bridge port therefore read as "a daemon is there", and since a stranger answers
 * and closes, every reattach dropped and reattached again: measured at nineteen reconnects in
 * forty-eight seconds, each logged as `reticle_mcp_proxy_reconnected`, forever. `probePresence`
 * already asks the second question and every human-facing command already uses it; this was the last
 * decision point still guessing from the first.
 */
export function onStreamDrop(presence: PortPresence): OnDrop {
  return PortPresence.DAEMON === presence ? OnDrop.REATTACH : OnDrop.DORMANT;
}

/**
 * What to do when the reconnect budget runs out. Always DORMANT — never exit.
 *
 * The proxy used to `process.exit(1)` here, justified as "let the agent host respawn the proxy". No
 * host does that: a stdio MCP server that exits is marked DISCONNECTED, its tools disappear from the
 * session, and a human has to open /mcp and reconnect by hand. That is the worst thing this product
 * does to anyone, and it was deliberate.
 *
 * Exiting bought nothing. Dormant already covers every case exit was meant to: the handshake is
 * answered locally, `tools/list` is answered from the catalog cache, and the next client request
 * WAKES a daemon. The budget still exists — it decides when to stop burning CPU on retries, not
 * whether the server survives.
 */
export function onReconnectBudgetSpent(): OnDrop {
  return OnDrop.DORMANT;
}

/**
 * What to do when queued requests expire with nothing connected. Always DORMANT.
 *
 * This is the hole that produced the worst report we have had: a first-run daemon came up wedged, the
 * proxy spent its budget against it, and from then on every call returned −32001 — including after
 * the human killed the wedged process and started a healthy daemon on the same port. The proxy never
 * looked again.
 *
 * The cause is a state that lies. `WAKE` clears `dormant` and starts a reconnect; if that reconnect
 * neither resolves nor rejects (exactly what a wedged port does — it accepts the socket and never
 * serves SSE), `dormant` stays false forever. Every later request then reads as "a reconnect is
 * already coming" and QUEUEs, the queue expires, and the request is answered with a failure. Nothing
 * in that loop ever re-probes the port, so a daemon that appears afterwards is invisible.
 *
 * Expiring the queue is the proof that the in-flight reconnect is not coming. Going dormant makes the
 * NEXT client request wake and re-probe — which is the only thing that can discover a daemon that
 * arrived late, and it costs nothing when one has not.
 */
export function onQueueExpired(): OnDrop {
  return OnDrop.DORMANT;
}

/** What to do with a client message. */
export const OnRequest = {
  /** Connected — post it straight through. */
  SEND: 'send',
  /** Reconnecting already; hold it until the endpoint arrives. */
  QUEUE: 'queue',
  /** Dormant: this is demand. Start a daemon, reattach, then flush. */
  WAKE: 'wake',
} as const;
export type OnRequest = (typeof OnRequest)[keyof typeof OnRequest];

/**
 * The client asking for something is the ONLY event that may start a daemon.
 *
 * `connected` means a session endpoint is in hand. When it is not, a dormant proxy wakes (spawning
 * if needed) and a merely-reconnecting one queues — the difference between "nothing is coming back
 * on its own" and "something already is".
 */
export function onClientRequest(connected: boolean, dormant: boolean): OnRequest {
  if (connected) return OnRequest.SEND;
  return dormant ? OnRequest.WAKE : OnRequest.QUEUE;
}

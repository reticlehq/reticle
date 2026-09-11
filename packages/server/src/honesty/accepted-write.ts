import { EventType, HTTP_ACCEPTED, isDevToolingUrl, type ReticleEvent } from '@reticlehq/core';
import { asNumber, asString } from '../tools/tools-helpers.js';

/**
 * Did a write in this window answer `202 Accepted`?
 *
 * `202` is the only status in HTTP whose meaning is "no outcome yet" — the server took the request
 * and has not finished with it. Folding it into the 2xx success band is how an asynchronous workflow
 * gets a green verdict at exactly the moment nothing has been decided.
 *
 * Measured on a logistics console with server-side reconciliation: a dispatch answered 202, the row
 * optimistically rendered "dispatched", the page settled, every channel agreed — and the server
 * REVERTED it to `held` 1.2 s later. The verdict was not wrong about what it observed. It was early,
 * and nothing in the response said so except the status code nobody was reading.
 *
 * The DEV TOOLCHAIN's own traffic is excluded, on the same rule every other check applies: a verdict
 * about the app must not be decided by a request the app did not make.
 */
export function hasAcceptedWrite(events: readonly ReticleEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === EventType.NET_REQUEST &&
      asNumber(e.data['status']) === HTTP_ACCEPTED &&
      !isDevToolingUrl(asString(e.data['url'])),
  );
}

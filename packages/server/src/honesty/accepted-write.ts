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
/**
 * Which writes in this window answered `202 Accepted`, as "METHOD url".
 *
 * The verdict tells the agent to re-check once the server reconciles. That instruction is only
 * usable if the agent knows WHAT to re-check: a window with three requests and a verdict saying
 * "a write returned 202" leaves it guessing which one, and guessing wrong means watching a request
 * that already finished while the real one is still pending.
 *
 * Duplicates are folded, so a retried request names its endpoint once instead of filling the
 * sentence with the same line three times.
 */
export function acceptedWriteLabels(events: readonly ReticleEvent[]): string[] {
  const labels: string[] = [];
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    if (asNumber(event.data['status']) !== HTTP_ACCEPTED) continue;
    const url = asString(event.data['url']);
    if (isDevToolingUrl(url)) continue;
    const method = (
      'string' === typeof event.data['method'] ? event.data['method'] : ''
    ).toUpperCase();
    const label = `${method} ${url ?? ''}`.trim();
    if ('' !== label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Did a write in this window answer `202 Accepted`?
 *
 * Derived from the labels above rather than repeating the filter, so the question and the list can
 * never disagree about which requests count.
 */
export function hasAcceptedWrite(events: readonly ReticleEvent[]): boolean {
  return acceptedWriteLabels(events).length > 0;
}

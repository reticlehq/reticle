import {
  EventType,
  MUTATING_METHODS,
  NetInitiator,
  isDevToolingUrl,
  type ReticleEvent,
} from '@reticlehq/core';
import { asString } from '../tools/tools-helpers.js';

const IPC_METHOD = NetInitiator.IPC.toUpperCase();

/**
 * A write whose outcome is sitting in a payload nobody read.
 *
 * `findBodyFailures` catches a 2xx that reports failure inside its body — but only when body capture
 * is on, and it is OFF by default. Without this, the same window produces `verified: "yes"` with the
 * reason "no channel disagreeing", which is true only because one channel was never opened. That is
 * lying by omission, and it is the precise failure this honesty layer exists to prevent.
 *
 * Measured on a shipments console: `POST /api/bulk-hold` → 200, banner reads "9 shipments held",
 * three of the nine failed inside the body. With capture on Reticle now says so. With capture off it
 * said `verified: "yes"`.
 *
 * Deliberately narrow, because over-warning trains agents to ignore the field:
 *
 *  - **writes only.** A GET's payload is what the UI renders, so the DOM already witnesses it. A
 *    write's outcome has no other witness.
 *  - **a payload that DEMONSTRABLY exists.** `responseSize > 0` with no recorded body means unread.
 *    An absent size or a genuinely empty response says nothing and is left alone — the distinction
 *    between "empty" and "unseen" is the whole point, so it must not be guessed.
 *  - **HTTP only.** An IPC record is excluded, and the reason is the rule's own premise: a 2xx is
 *    emitted by a framework whatever the app decided, so it describes the transport. An IPC `ok`
 *    means the main-process handler ran to completion without throwing — an application-level
 *    verdict, already reported. Treating the two as equivalent made every ordinary Electron action
 *    return `unknown` (measured: a healthy `todos:add` on the default config), which is the
 *    cry-wolf failure that teaches agents to ignore the field.
 *
 *    The residual gap is real and narrower: a handler that RESOLVES with a failure inside its payload
 *    is invisible without body capture. That case is `findBodyFailures`, which reads the payload and
 *    catches it precisely — with capture on, where it belongs.
 *
 *  - **the app's own traffic only.** The DEV TOOLCHAIN writes too: Next's overlay answers
 *    `POST /__nextjs_original-stack-frames` with a JSON body the moment the app logs one React
 *    warning, and nothing captures it. Judged as the app's write, that made every verdict in a Next
 *    dev app `unknown` — decided by a channel the caller never asked about, on a request the app did
 *    not make. `findContradictions` has split this traffic out for the same reason since the overlay
 *    turned correct navigations red; this rule was reading the unsplit window.
 */
const OK_MIN = 200;
const OK_MAX = 300;

/**
 * The writes whose outcome went unread, as "METHOD url".
 *
 * Named rather than counted, because a caveat an agent cannot locate is a caveat it learns to skip.
 * The sentence used to say "a write returned 2xx with a response body that was never recorded" and
 * name no write, which is unactionable on any page that makes more than one call.
 */
export function unreadWriteLabels(events: readonly ReticleEvent[]): string[] {
  const labels: string[] = [];
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    const method = (
      'string' === typeof event.data['method'] ? event.data['method'] : ''
    ).toUpperCase();
    if (method === IPC_METHOD || !MUTATING_METHODS.includes(method)) continue;
    const url = asString(event.data['url']);
    if (isDevToolingUrl(url)) continue;
    const status = event.data['status'];
    if (typeof status !== 'number' || status < OK_MIN || status >= OK_MAX) continue;
    if (event.data['responseBody'] !== undefined) continue; // read — findBodyFailures judged it
    const size = event.data['responseSize'];
    if ('number' !== typeof size || size <= 0) continue;
    const label = `${method} ${url ?? ''}`.trim();
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function hasUnreadWriteOutcome(events: readonly ReticleEvent[]): boolean {
  return unreadWriteLabels(events).length > 0;
}

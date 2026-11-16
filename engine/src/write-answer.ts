/**
 * Whether the client answered a successful write, for `response-ignored` (#2115).
 *
 * Split out of `disagreement/contradiction-evidence.ts`, which is at the line cap. It sits here,
 * next to `state-bookkeeping.ts`, so the `disagreement` folder gets no new public path. It reads the
 * order of events against each write's send, with the helpers that file uses for success claims.
 */

import { EventType, asString, type ReticleEvent } from '@reticlehq/core';
import { emittedBefore, sendOf, type NetCall } from './disagreement/contradiction-evidence.js';

/** A change of the DOM, the store or the route: the client moved. */
export const movesUi = (e: ReticleEvent): boolean =>
  e.type === EventType.DOM_ADDED ||
  e.type === EventType.DOM_REMOVED ||
  e.type === EventType.DOM_ATTR ||
  e.type === EventType.DOM_TEXT ||
  e.type === EventType.STATE_CHANGE ||
  e.type === EventType.ROUTE_CHANGE;

/**
 * The attributes a control sets while it waits for its request: `disabled` and `aria-busy`. Neither
 * applies the write, so neither is an optimistic update. The browser observer records `disabled`
 * today and not `aria-busy`; a realm that records it gets the same reading.
 */
const DISABLED_ATTR = 'disabled';
const ARIA_BUSY_ATTR = 'aria-busy';
/** The `aria-busy` value that marks a control as busy. Any other value, or none, clears it. */
const ARIA_BUSY_ON = 'true';
const WAITING_ATTRS: ReadonlySet<string> = new Set([DISABLED_ATTR, ARIA_BUSY_ATTR]);

/** Whether this change puts the control into its waiting state, rather than taking it out. */
function setsWaiting(e: ReticleEvent): boolean {
  const value = asString(e.data['value']);
  return ARIA_BUSY_ATTR === asString(e.data['attr']) ? ARIA_BUSY_ON === value : value !== undefined;
}

/**
 * Did the client move in a way that can answer these successful writes?
 *
 * The acted control becoming `disabled` or `aria-busy` after the write was sent cannot answer it
 * (#2115). It is the control saying "wait" while the request runs. It made `uiAdvanced` true, and
 * the rule stood down on an app that ignored its response. A change of those attributes before the
 * send, such as a fill enabling its submit button, is not about the write at all.
 *
 * After the send, every change that takes the control out of its waiting state still counts. The
 * limit is the send and not the answer, because the answer can be recorded after the app's own
 * handler ran: over XHR on `loadend`, after the `load` handler and axios's, and with body capture
 * after the body was read. A settings form that enables Save again in its response handler is
 * correct, because its fields already show the saved values.
 *
 * Two limits, on purpose. A control that only becomes disabled after the answer, with nothing else
 * moving, is reported: the same reading as the waiting state. And a label on the control
 * (`dom.text`, such as "Saving…") still counts wherever it is, because a label can also carry the
 * result, such as a count on a like button.
 *
 * Every other change still counts wherever it is, so an optimistic update is still an answer. The
 * order is the page's own sequence number, because the bridge stamps the time when an event
 * arrives, not when the page made it. When the window cannot say what came first (no acted
 * control, or no send), every change counts, as before.
 */
export function answersWrites(
  events: readonly ReticleEvent[],
  writes: readonly NetCall[],
  ref: string | undefined,
): boolean {
  if (ref === undefined) {
    return events.some(movesUi);
  }
  const sends: ReticleEvent[] = [];
  for (const call of writes) {
    const send = sendOf(events, call);
    if (send === undefined) {
      return events.some(movesUi);
    }
    sends.push(send);
  }
  const waiting = (e: ReticleEvent): boolean =>
    e.type === EventType.DOM_ATTR &&
    e.ref === ref &&
    WAITING_ATTRS.has(asString(e.data['attr']) ?? '') &&
    (sends.every((send) => emittedBefore(e, send)) || setsWaiting(e));
  return events.some((e) => movesUi(e) && !waiting(e));
}

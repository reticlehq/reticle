/**
 * One session's evidence, as a contribution to the coverage ledger.
 *
 * Pure over what the caller read: the controls on the page, the labels the session drove and proved,
 * where it is, and the events it holds. The ledger does the accumulating; this only says what one
 * session saw.
 */

import {
  EventType,
  MUTATING_METHODS,
  asNumber,
  asString,
  type ReticleEvent,
} from '@reticlehq/core';
import { routeFromUrl, routesFromEvents } from '@/memory/project/learned-routes.js';
import type { LedgerDelta } from './ledger.js';

/** A path segment that is a record id rather than part of the endpoint's name. */
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

/**
 * `POST /api/orders/:id/refund` for a mutating request, else undefined. Ids are collapsed so the
 * refund of order 41 and of order 42 are one endpoint with one failure path to drive, not two.
 */
export function writeKeyOf(event: ReticleEvent): string | undefined {
  if (EventType.NET_REQUEST !== event.type) {
    return undefined;
  }
  const method = asString(event.data['method'])?.toUpperCase();
  const url = asString(event.data['url']);
  if (method === undefined || url === undefined || !MUTATING_METHODS.includes(method)) {
    return undefined;
  }
  let path: string;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
  const named = path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${named}`;
}

/**
 * The ledger's identity for a control: the snapshot label, with numbers collapsed. The rows of a
 * table — `button "Delete row 12"` — are one control to cover, not five hundred, which is what keeps
 * `touched` meaningful on any page with a list.
 */
export function controlKey(label: string): string {
  const bare = label.replace(/^\s*-\s*/, '').replace(/\s*\(ref=e\d+\)/, '');
  // Role and accessible name only. Attributes are the control's momentary STATE — the value typed
  // into it, whether it has focus — and keying on them made one control several, and every
  // keystroke a new page state. Found by driving the fixture.
  const identity = /^(\S+(?:\s+"(?:[^"\\]|\\.)*")?)/.exec(bare)?.[1] ?? bare;
  return identity.replace(/\d+/g, '#').trim();
}

export function sessionDelta(input: {
  seen: readonly string[];
  acted: Iterable<string>;
  proved: Iterable<string>;
  url?: string;
  events: readonly ReticleEvent[];
}): LedgerDelta {
  const here = input.url === undefined ? undefined : routeFromUrl(input.url);
  const reached = [
    ...new Set([...(here === undefined ? [] : [here]), ...routesFromEvents(input.events)]),
  ];
  const writes = [
    ...new Set(input.events.map(writeKeyOf).filter((k): k is string => k !== undefined)),
  ];
  return {
    routes: { reached },
    controls: {
      seen: [...new Set([...input.seen].map(controlKey))],
      touched: [...new Set([...input.acted].map(controlKey))],
      proved: [...new Set([...input.proved].map(controlKey))],
    },
    writes: { seen: writes },
  };
}

/** An error the page threw or logged — a fault whatever the screen shows. */
export function isConsoleError(e: ReticleEvent): boolean {
  return e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT;
}

/** Requests that answered at or above `floor`. */
export function failedRequests(events: ReticleEvent[], floor: number): ReticleEvent[] {
  return events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST) {
      return false;
    }
    const status = asNumber(e.data['status']);
    return status !== undefined && status >= floor;
  });
}

/** Any buffer event that proves the app reacted to a click (vs a dead/no-op control). */
export function isActivity(e: ReticleEvent): boolean {
  return (
    e.type === EventType.NET_REQUEST ||
    e.type === EventType.DOM_ADDED ||
    e.type === EventType.DOM_REMOVED ||
    e.type === EventType.DOM_ATTR ||
    e.type === EventType.DOM_TEXT ||
    e.type === EventType.ROUTE_CHANGE ||
    e.type === EventType.SIGNAL ||
    e.type === EventType.ANIM_START ||
    e.type === EventType.ANIM_END
  );
}

/**
 * Controls whose correct behaviour IS to do nothing when clicked.
 *
 * Read off the same descriptor the crawler already has, so no extra round trip: `[disabled]` is inert
 * by definition, an already `[checked]` radio/checkbox is idempotent, and clicking a text field
 * focuses it rather than changing anything.
 */
export function legitimatelyInert(desc: string): boolean {
  if (desc.includes('[disabled]')) {
    return true;
  }
  if (desc.includes('[checked]')) {
    return true;
  }
  // Inputs, and the ARIA LIVE-REGION roles.
  //
  // `alert`, `status`, `log`, `timer` and `marquee` exist to be READ — a screen reader announces
  // them and nothing is meant to happen when one is clicked. Clicking twice and seeing nothing is
  // therefore correct behaviour, and reporting it as `dead-control` accuses a working app.
  //
  // Found by driving a real app: the demo reported `dead-control — alert "Invalid email or
  // password"`, which is a login form correctly telling somebody their password was wrong. That is
  // the most expensive kind of false positive there is — the strongest claim the crawler makes,
  // about an app that was working, and on the path a new user meets first.
  //
  // `alertdialog` is deliberately NOT here: it is interactive, and a word boundary keeps it out.
  return /\b(textbox|searchbox|combobox|spinbutton|alert|status|log|timer|marquee)\b/.test(desc);
}

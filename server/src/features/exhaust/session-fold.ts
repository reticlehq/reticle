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
  if (EventType.NET_REQUEST !== event.type) return undefined;
  const method = asString(event.data['method'])?.toUpperCase();
  const url = asString(event.data['url']);
  if (method === undefined || url === undefined || !MUTATING_METHODS.includes(method))
    return undefined;
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
  return label
    .replace(/^\s*-\s*/, '')
    .replace(/\s*\(ref=e\d+\).*$/, '')
    .replace(/\d+/g, '#')
    .trim();
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
    if (e.type !== EventType.NET_REQUEST) return false;
    const status = asNumber(e.data['status']);
    return status !== undefined && status >= floor;
  });
}

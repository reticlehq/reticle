/**
 * One session's evidence, as a contribution to the coverage ledger.
 *
 * Pure over what the caller read: the controls on the page, the labels the session drove and proved,
 * where it is, and the events it holds. The ledger does the accumulating; this only says what one
 * session saw.
 */

import { EventType, MUTATING_METHODS, asString, type ReticleEvent } from '@reticlehq/core';
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
    controls: { seen: [...input.seen], touched: [...input.acted], proved: [...input.proved] },
    writes: { seen: writes },
  };
}

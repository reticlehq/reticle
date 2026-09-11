import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import type { OwnContradiction } from './contradictions.js';

/**
 * The app sent a money value back in a DIFFERENT unit than the API gave it.
 *
 * Payment APIs overwhelmingly speak minor units — Stripe, Razorpay, Adyen, PayPal all state amounts
 * in paise/cents as integers. A UI renders that as a major-unit string, and the bug is writing the
 * rendered number back into the field the integer came from.
 *
 * Measured on a real payments dashboard: `GET /payments` returns `amount: 118701` for a payment, the
 * row renders "₹1,187.01", and the refund posts `{"amount": 1187.01}` into the same field. The server
 * takes 1187 paise and answers `200 {"status": "processed"}`. That is a 100x UNDER-REFUND, and every
 * channel agrees it worked: the status is 200, the payload says processed, the UI advances, the page
 * settles, and the number in the request is exactly the number on the screen. Nothing disagrees,
 * because the disagreement is with a value the API returned EARLIER in the session.
 *
 * Which is the point: this is only visible to something holding the whole request timeline with
 * bodies. A snapshot cannot see it, a status column cannot see it, and a human reading the request
 * sees the amount they expected.
 *
 * Not a heuristic about decimals. Firing on "an amount had a fractional part" would accuse every API
 * that legitimately uses major units. This fires only when the SAME field of the SAME entity was
 * observed at a different scale — a comparison, not a guess.
 */

/** Fields worth comparing. Deliberately short: money, not every number an app sends. */
const MONEY_FIELDS = new Set(['amount', 'value', 'price', 'total', 'fee', 'cost', 'balance']);

/**
 * Scales that indicate a minor/major confusion. 100 covers two-decimal currencies; 1000 covers the
 * three-decimal ones (KWD, BHD, JOD, TND).
 */
const SCALES = [100, 1000] as const;

/**
 * Prefixed ids (`pay_NkT10001`) and uuids, matched anywhere in a URL or a string field.
 *
 * Numeric ids are handled separately by path segment: `/api/orders/9/capture` is at least as common
 * as a prefixed id, and a bare `9` cannot be pattern-matched out of arbitrary text without matching
 * every other number too.
 */
const ID_PATTERN = /[A-Za-z]{2,}_[A-Za-z0-9]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/g;

function parse(raw: unknown): unknown {
  if (typeof raw !== 'string' || 0 === raw.length) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Every (id, field, value) triple in a payload, from objects that carry an id of their own. */
function moneyByEntity(node: unknown, into: Map<string, Map<string, number>>): void {
  if (Array.isArray(node)) {
    for (const item of node) moneyByEntity(item, into);
    return;
  }
  if (typeof node !== 'object' || null === node) return;
  const record = node as Record<string, unknown>;
  // An id may arrive as a number (`{"id": 9}`) — normalised so a numeric path segment matches it.
  const raw = record['id'];
  const id = 'string' === typeof raw ? raw : 'number' === typeof raw ? String(raw) : undefined;
  if (id !== undefined) {
    for (const [key, value] of Object.entries(record)) {
      if (!MONEY_FIELDS.has(key) || typeof value !== 'number') continue;
      const fields = into.get(id) ?? new Map<string, number>();
      fields.set(key, value);
      into.set(id, fields);
    }
  }
  for (const value of Object.values(record)) moneyByEntity(value, into);
}

/** Ids named anywhere in a URL or a request payload — how a write says which entity it targets. */
function idsIn(url: string, body: unknown): string[] {
  const found = new Set(url.match(ID_PATTERN) ?? []);
  // Numeric path segments: `/api/orders/9/capture` names entity 9.
  for (const segment of url.split('?')[0]?.split('/') ?? []) {
    if (segment.length > 0 && /^\d+$/.test(segment)) found.add(segment);
  }
  if ('object' === typeof body && body !== null) {
    for (const value of Object.values(body as Record<string, unknown>)) {
      if ('string' === typeof value) for (const id of value.match(ID_PATTERN) ?? []) found.add(id);
    }
  }
  return Array.from(found);
}

/** The scale between a known value and a sent one, or undefined when they are consistent. */
function scaleBetween(known: number, sent: number): number | undefined {
  if (0 === sent || 0 === known) return undefined;
  for (const scale of SCALES) {
    // A tolerance, because the major-unit form is a rounded render of the minor one.
    if (Math.abs(known - sent * scale) <= scale / 2) return scale;
  }
  return undefined;
}

/**
 * @param prior events from BEFORE the window, used only to learn what the API has stated.
 *
 * The scale error is a disagreement with a value the API gave EARLIER — by definition before the
 * action that sends it back. `reticle_assert` scopes its window to the last act's cursor, so the
 * stating response falls outside it and `known` is empty exactly when it matters. Measured live on
 * the payments panel: `reticle_observe` over a wide window reported the mismatch while `assert` on
 * the same session reported none — the verdict tool, the one an agent gates on, was the blind one.
 *
 * Prior events TEACH, they are never themselves findings: widening the window instead would make
 * every other rule blame this action for events it did not cause, and would re-report every earlier
 * mistake on every assert.
 */
export function findUnitMismatches(
  events: readonly ReticleEvent[],
  prior: readonly ReticleEvent[] = [],
): OwnContradiction[] {
  // What the API has told us about each entity so far, in the API's own units.
  const known = new Map<string, Map<string, number>>();
  for (const event of prior) {
    if (event.type !== EventType.NET_REQUEST) continue;
    const body = parse(event.data['responseBody']);
    if (body !== undefined) moneyByEntity(body, known);
  }
  const found: OwnContradiction[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    const url = 'string' === typeof event.data['url'] ? event.data['url'] : '';
    const requestBody = parse(event.data['requestBody']);

    // Compare BEFORE recording this call's own response, or a request that echoes its own reply
    // would compare against itself.
    if ('object' === typeof requestBody && requestBody !== null) {
      const sentFields = requestBody as Record<string, unknown>;
      for (const id of idsIn(url, requestBody)) {
        const fields = known.get(id);
        if (fields === undefined) continue;
        for (const [key, sent] of Object.entries(sentFields)) {
          if (!MONEY_FIELDS.has(key) || typeof sent !== 'number') continue;
          const priorValue = fields.get(key);
          if (priorValue === undefined) continue;
          const scale = scaleBetween(priorValue, sent);
          if (scale === undefined) continue;
          const key2 = `${id}:${key}`;
          if (seen.has(key2)) continue;
          seen.add(key2);
          found.push({
            kind: ContradictionKind.UNIT_MISMATCH,
            claim: `the request sent ${key}=${String(sent)} and the server accepted it`,
            counter: `the API reports ${key}=${String(priorValue)} for ${id} — the value sent is ${String(scale)}x SMALLER, i.e. a major-unit number written into a minor-unit field`,
            detail: `${url} — at this scale the operation moves ${String(sent)} minor units instead of ${String(priorValue)}; nothing else can see this, because the number sent is exactly the number rendered on screen`,
          });
        }
      }
    }

    const responseBody = parse(event.data['responseBody']);
    if (responseBody !== undefined) moneyByEntity(responseBody, known);
  }
  return found;
}

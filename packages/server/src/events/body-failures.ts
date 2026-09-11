import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import type { OwnContradiction } from './contradictions.js';

/**
 * A request that returned 2xx and reported failure INSIDE its body.
 *
 * The status line is not the outcome. Three shapes make this routine rather than exotic:
 *
 *  - **GraphQL** answers HTTP 200 for every error it has ever produced. `errors: [...]` in a 200 body
 *    is the normal way a GraphQL request fails, so any verdict that reads only the status is blind to
 *    the entire error surface of an entire ecosystem.
 *  - **Bulk endpoints** answer 200 for the batch and put per-item results in the body. Measured on a
 *    shipments console: `POST /api/bulk-hold` → 200, banner reads "9 shipments held", and three of
 *    the nine carry `{"ok": false, "error": "carrier_locked"}`. Reticle had that body in hand and
 *    reported `verified: "yes"`.
 *  - **Envelope APIs** answer 200 with `{"success": false}` — common wherever a gateway normalises
 *    status codes.
 *
 * Every channel above the body agrees with the lie: the request succeeded, the UI advanced, the page
 * settled, nothing 5xx'd. Only the payload disagrees, which is why this needs body capture — and why
 * an agent reading a status column can never catch it.
 */

/** Keys whose truthiness means "this failed". Checked at the top level and per item. */
const FAILURE_FLAGS = ['ok', 'success', 'succeeded'] as const;

/** Keys that, when carrying content, name a failure. */
const ERROR_KEYS = ['error', 'errors', 'errorMessage', 'failureReason'] as const;

/** Arrays worth walking for per-item outcomes. Bulk APIs converge on a handful of names. */
const ITEM_KEYS = ['results', 'items', 'data', 'records', 'responses'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/** Whether one object reports a failure of its own. */
function reportsFailure(item: unknown): boolean {
  if (!isRecord(item)) return false;
  for (const flag of FAILURE_FLAGS) {
    if (false === item[flag]) return true;
  }
  for (const key of ERROR_KEYS) {
    const value = item[key];
    if (value === undefined || null === value) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return true;
      continue;
    }
    // An empty string or an explicit null is an API saying "no error", not an error.
    if ('string' === typeof value && 0 === value.length) continue;
    return true;
  }
  return false;
}

/** Failed / total across the first item array found. Zero total when the body is not a batch. */
function itemOutcomes(body: Record<string, unknown>): { failed: number; total: number } {
  for (const key of ITEM_KEYS) {
    const list = body[key];
    if (!Array.isArray(list) || 0 === list.length) continue;
    const failed = list.filter(reportsFailure).length;
    return { failed, total: list.length };
  }
  return { failed: 0, total: 0 };
}

function parse(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || 0 === raw.length) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // not JSON — nothing to read, and guessing at prose would invent findings
  }
}

const OK_MIN = 200;
const OK_MAX = 300;

/** Contradictions for 2xx responses whose bodies report failure. One per offending call. */
export function findBodyFailures(events: readonly ReticleEvent[]): OwnContradiction[] {
  const found: OwnContradiction[] = [];
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    const status = event.data['status'];
    if (typeof status !== 'number' || status < OK_MIN || status >= OK_MAX) continue;
    const body = parse(event.data['responseBody']);
    if (body === undefined) continue;

    const url = 'string' === typeof event.data['url'] ? event.data['url'] : '';
    const method = 'string' === typeof event.data['method'] ? event.data['method'] : '';
    const where = `${method} ${url} → ${String(status)}`;

    const { failed, total } = itemOutcomes(body);
    if (failed > 0) {
      found.push({
        kind: ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE,
        claim: `the request returned ${String(status)} and the page treated it as done`,
        counter: `its body reports ${String(failed)} of ${String(total)} items FAILED`,
        detail: `${where} — a batch endpoint's status describes the BATCH, not the items; whatever the UI says it did, ${String(failed)} of them did not happen`,
      });
      continue;
    }
    if (reportsFailure(body)) {
      found.push({
        kind: ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE,
        claim: `the request returned ${String(status)} and the page treated it as done`,
        counter: 'its body reports the operation FAILED',
        detail: `${where} — the status line and the payload disagree; the payload is the outcome (a GraphQL error is always a 200)`,
      });
    }
  }
  return found;
}

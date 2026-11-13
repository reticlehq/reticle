import type { EndpointCalls } from '@/window/event-filters.js';
import type { EvalResult } from './predicate-eval-kit.js';

/**
 * How long a status miss waits after the last answer to its endpoint before it is decided (#1656).
 *
 * A miss is decided when every settled call to the method and URL answered another status and none
 * is in flight. Without a hold, that is true for a moment between an answer and the retry that the
 * app sends next. The retry's start can reach the bridge after the answer, so the wait could end
 * with `no` before a retry that answers the expected status.
 *
 * 1.5 s covers a retry sent at once, and a first retry after 1 s, which is the React Query default.
 * It is a ceiling, not a proof: a retry that starts more than 1.5 s after the last answer is not
 * waited for, and the verdict is `no` on the evidence seen. Without this rule, the same miss was
 * never final, and a slow page turned it into `unknown` when the budget ended.
 */
export const STATUS_MISS_HOLD_MS = 1_500;

/** How a status-miss sentence names an endpoint whose predicate gives no method. */
const ANY_METHOD = 'any method';
/** How it names an endpoint whose predicate gives no URL fragment. */
const ANY_URL = '*';

/** The fields of a `net` predicate that this rule reads. */
interface StatusClaim {
  method?: string | undefined;
  urlContains?: string | undefined;
  status?: number | undefined;
  count?: number | undefined;
}

/** The outcome of a status miss: decided, or a time to check again. */
export type StatusMiss =
  { decided: true; observedStatuses: readonly number[] } | { decided: false; retryAfterMs: number };

/**
 * Can a `net` miss on `status` be decided now (#1656)?
 *
 * Undefined when the rule does not apply: the predicate has no status, or counts calls, or there
 * is no clock, or no call to the endpoint settled in the window, or one settled with no readable
 * status, or one settled with the expected status (another filter rejected it), or a call to the
 * endpoint is in flight. In all of these a later event can still change the answer, or the miss is
 * not about the status.
 *
 * Otherwise every settled call to the endpoint answered another status. The miss is decided when
 * the hold after the last answer is over. While the hold runs, the result says when to check again.
 */
export function statusMiss(
  calls: EndpointCalls,
  p: StatusClaim,
  now: number | undefined,
): StatusMiss | undefined {
  if (p.status === undefined || p.count !== undefined || now === undefined) {
    return undefined;
  }
  if (calls.inFlight || 0 === calls.settled.length) {
    return undefined;
  }
  const observedStatuses: number[] = [];
  for (const call of calls.settled) {
    if (call.status === undefined || call.status === p.status) {
      return undefined;
    }
    observedStatuses.push(call.status);
  }
  const lastAnswer = Math.max(...calls.settled.map((call) => call.t));
  const quietFor = now - lastAnswer;
  if (quietFor < STATUS_MISS_HOLD_MS) {
    return { decided: false, retryAfterMs: STATUS_MISS_HOLD_MS - quietFor };
  }
  return { decided: true, observedStatuses };
}

/** The sentence for a decided status miss. It names each status the endpoint answered. */
export function describeStatusMiss(p: StatusClaim, observedStatuses: readonly number[]): string {
  const endpoint = `${p.method ?? ANY_METHOD} ${JSON.stringify(p.urlContains ?? ANY_URL)}`;
  const seen = [...new Set(observedStatuses)].map(String).join(', ');
  const calls = String(observedStatuses.length);
  return `${calls} call(s) to ${endpoint} answered ${seen}, not the expected ${String(p.status)}. No call to it was in flight, and none started for ${String(STATUS_MISS_HOLD_MS)} ms after the last answer.`;
}

/**
 * Add the status-miss decision to a plain `net` miss, or return the miss unchanged.
 *
 * A decided miss names the statuses in `failureReason`. A miss in its hold carries `retryAfterMs`,
 * so the wait checks again when the hold ends instead of on the next poll.
 */
export function withStatusMiss(
  miss: EvalResult,
  calls: EndpointCalls,
  p: StatusClaim,
  now: number | undefined,
): EvalResult {
  const outcome = statusMiss(calls, p, now);
  if (outcome === undefined) {
    return miss;
  }
  if (!outcome.decided) {
    return { ...miss, retryAfterMs: outcome.retryAfterMs };
  }
  return { ...miss, failureReason: describeStatusMiss(p, outcome.observedStatuses), decided: true };
}

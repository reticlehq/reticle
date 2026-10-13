/**
 * What to do when the observer left in the middle of an act.
 *
 * A full-document navigation — often the very thing the act CAUSED — tears the SDK down. The page
 * re-announces, and whatever this call still had in flight is gone. That is a fact about the
 * observer, never about the application, and the difference matters: every honest verdict this
 * engine can give depends on not converting "I stopped watching" into "your app is broken".
 *
 * Its own module because it is one idea — follow the document that took over, and re-ask there —
 * used from the two points where observation can be lost: a write rejected at dispatch, and a wait
 * cut off mid-predicate.
 */

import { EventType, asRecord, asString, isDevToolingUrl, type ReticleEvent } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import {
  awaitDocumentSuccessor,
  type SuccessorRegistry,
} from '@/portal/session/session-successor.js';
import type { EvalResult } from '@reticlehq/engine/question/predicate/predicate-eval.js';

interface FollowSuccessor {
  sessions: SuccessorRegistry;
  session: Session;
  verdict: EvalResult;
  /** Total budget the CALLER granted, in ms. */
  timeout: number;
  /** `session.elapsed()` at the moment the predicate started. */
  predicateStarted: number;
  /** Re-ask the declared consequence on `next`, with whatever budget is left. */
  reevaluate: (next: Session, budgetMs: number) => Promise<EvalResult>;
}

interface FollowedOutcome {
  session: Session;
  verdict: EvalResult;
  /** True when the wait moved to a new document, so the caller must reset its event cursor. */
  followed: boolean;
}

/**
 * Follow the unique same-origin successor and re-ask there, or leave the verdict untouched.
 *
 * `navigate` already waits for the HELLO and returns the new id; this path used to grade
 * `observation_lost` and leave the agent holding a DEAD id, so the next assert failed even though
 * the new page had loaded perfectly. Two live tabs at that origin is still a guess, and
 * `awaitDocumentSuccessor` refuses to guess — a wrong follow drives somebody else's app.
 */
export async function followLostObservation(input: FollowSuccessor): Promise<FollowedOutcome> {
  const { sessions, session, verdict, timeout, predicateStarted, reevaluate } = input;
  if (true !== verdict.observationLost || 0 >= timeout)
    return { session, verdict, followed: false };

  const remaining = timeout - (session.elapsed() - predicateStarted);
  const next = remaining > 0 ? await awaitDocumentSuccessor(sessions, session, remaining) : null;
  if (null === next) return { session, verdict, followed: false };

  // Computed on the DEPARTED session, before the caller points at the successor: the new session's
  // elapsed() starts at 0 and would silently refund the whole budget the caller had already spent.
  const leftover = timeout - (session.elapsed() - predicateStarted);
  if (leftover <= 0) return { session: next, verdict, followed: true };
  return { session: next, verdict: await reevaluate(next, leftover), followed: true };
}

/** Why a consequence that did not follow a click on a disabled control is not the app's failure. */
export const DISABLED_TARGET_NOTE =
  'the control was disabled when it was acted on, so nothing a user could do there would have ' +
  'caused the declared consequence. Check why it was disabled (an empty required field, a save ' +
  'that already happened) before calling this a defect.';

/**
 * The page reports `enabled: false` on an act whose target was disabled at dispatch. A missed
 * consequence then says nothing about the app, so the verdict is undecided rather than "no".
 */
export function disabledTargetNote(pass: boolean, actResult: unknown): string | undefined {
  if (pass) return undefined;
  return false === asRecord(actResult)['enabled'] ? DISABLED_TARGET_NOTE : undefined;
}

/** Calls quoted on a failed check, and how much of each response body. */
const MAX_NET_CALLS = 5;
const MAX_BODY_CHARS = 300;

/**
 * The requests of a failed check's window, as its record carries them: method, url, status and the
 * start of the response body (redacted in the page before it was ever sent). Dev tooling is left out.
 */
/**
 * The requests a check keeps: on a miss, the window's calls that explain it; on a held network check,
 * the request that answered it, so a share page can name "a POST to /api/…", not "a request was seen".
 */
export function checkNet(
  verdict: { pass: boolean; evidence?: unknown },
  events: readonly ReticleEvent[],
): { net?: { method: string; url: string; status?: number; body?: string }[] } {
  if (!verdict.pass) return { net: windowNet(events) };
  const seen = asRecord(verdict.evidence);
  const method = asString(seen['method']);
  const url = asString(seen['url']);
  if (method === undefined || url === undefined) return {};
  const status = seen['status'];
  return { net: [{ method, url, ...('number' === typeof status ? { status } : {}) }] };
}

export function windowNet(
  events: readonly ReticleEvent[],
): { method: string; url: string; status?: number; body?: string }[] {
  const out: { method: string; url: string; status?: number; body?: string }[] = [];
  for (const event of events) {
    if (EventType.NET_REQUEST !== event.type) continue;
    const url = asString(event.data['url']);
    if (url === undefined || isDevToolingUrl(url)) continue;
    const status = event.data['status'];
    const body = asString(event.data['responseBody']);
    out.push({
      method: (asString(event.data['method']) ?? 'GET').toUpperCase(),
      url,
      ...('number' === typeof status ? { status } : {}),
      ...(body === undefined ? {} : { body: body.slice(0, MAX_BODY_CHARS) }),
    });
    if (MAX_NET_CALLS <= out.length) break;
  }
  return out;
}

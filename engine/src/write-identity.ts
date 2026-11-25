/**
 * What a request CARRIED, as far as the record knows, and which calls carried the same thing.
 *
 * Split out of `disagreement/contradiction-evidence.ts`, which is at the line cap. It sits here,
 * next to `write-answer.ts`, so the `disagreement` folder gets no new public path. The file it
 * left re-exports the three names, so the published import path does not move.
 */

import {
  NEXT_ACTION_FIELD,
  REQUEST_SHAPE_FIELD,
  asString,
  type ReticleEvent,
} from '@reticlehq/core';

/**
 * What this request CARRIED, as far as the record knows — `undefined` when it does not know.
 *
 * The page's shape fingerprint first: it is present on every request from an instrumented page,
 * including the overwhelming majority where body capture is off. A captured body is the fallback for
 * a realm that records one without a fingerprint (desktop IPC). Neither means the record does not
 * say what this request carried — a body the page could not read as text, or an SDK too old to
 * compute a fingerprint — and that is an ABSENCE of identity, not an identity shared with every
 * other silent request.
 *
 * A Server Action's action id joins both halves, and it is the half that survives a `FormData`
 * body: several actions POST to the page's own URL, so without it every call is an unknown identity
 * pooled with all the others, and no fingerprint can separate two that share a shape. The id alone
 * SPLITS two different actions; it cannot say that two runs of one action carried the same thing,
 * and `carried` keeps that limit on the record for the finding to say.
 */
export interface WriteIdentity {
  /** The value the grouping compares. */
  readonly key: string;
  /** Whether the key also describes WHAT the request carried, not only which action ran. */
  readonly carried: boolean;
}

const nonEmpty = (text: string | undefined): string | undefined =>
  text === undefined || 0 === text.length ? undefined : text;

export function identityOf(event: ReticleEvent): WriteIdentity | undefined {
  const action = asString(event.data[NEXT_ACTION_FIELD]);
  const shape = asString(event.data[REQUEST_SHAPE_FIELD]);
  const body = asString(event.data['requestBody']);
  const carried = nonEmpty(shape) ?? nonEmpty(body);
  if (action === undefined || 0 === action.length) {
    return carried === undefined ? undefined : { key: carried, carried: true };
  }
  return carried === undefined
    ? { key: action, carried: false }
    : { key: `${action}:${carried}`, carried: true };
}

/** Split calls to one endpoint into the sets that sent the same thing. Callers check first that
 * every identity is known; an unknown one would otherwise pool with every other unknown. */
export function groupByIdentity<T extends { identity: WriteIdentity | undefined }>(
  calls: readonly T[],
): T[][] {
  const byIdentity = new Map<string, T[]>();
  for (const call of calls) {
    const key = call.identity?.key ?? '';
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), call]);
  }
  return [...byIdentity.values()];
}

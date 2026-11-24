/**
 * The identity of a write: what the record can use to tell two requests apart.
 *
 * Split out of `contradiction-evidence.ts` whole, the way `write-answer.ts` was (#1521):
 * that file crossed the 1000-line cap when the shape fingerprint joined the identity, and
 * rule 6 says split before adding. This file borrows only names `contradiction-evidence.ts`
 * already borrowed, so the coupling count in `core-coupling-only-shrinks.test.ts` moves
 * only by the split itself.
 */

import {
  NEXT_ACTION_FIELD,
  REQUEST_BODY_SHAPE_FIELD,
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
  /**
   * The body's SHAPE fingerprint, when the page sent one: the coarse discriminator beside the
   * exact one in `key`. Two calls can share a shape and differ in `key` (a restamped double
   * submit), and that pair is reported as indistinguishable, not as a duplicate and not as a
   * pass. Absent on records from an SDK that does not send it, and on bodyless calls.
   */
  readonly shapeKey?: string;
}

const nonEmpty = (text: string | undefined): string | undefined =>
  text === undefined || 0 === text.length ? undefined : text;

export function identityOf(event: ReticleEvent): WriteIdentity | undefined {
  const action = asString(event.data[NEXT_ACTION_FIELD]);
  const shape = asString(event.data[REQUEST_SHAPE_FIELD]);
  const bodyShape = nonEmpty(asString(event.data[REQUEST_BODY_SHAPE_FIELD]));
  const body = asString(event.data['requestBody']);
  const carried = nonEmpty(shape) ?? nonEmpty(body);
  if (action === undefined || 0 === action.length) {
    return carried === undefined
      ? undefined
      : {
          key: carried,
          carried: true,
          ...(bodyShape === undefined ? {} : { shapeKey: bodyShape }),
        };
  }
  return carried === undefined
    ? { key: action, carried: false }
    : {
        key: `${action}:${carried}`,
        carried: true,
        ...(bodyShape === undefined ? {} : { shapeKey: bodyShape }),
      };
}

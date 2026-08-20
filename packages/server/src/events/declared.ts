/**
 * What the caller DECLARED before acting — the oracle, read back.
 *
 * `act_and_wait` asks the agent to name the expected consequence BEFORE the action, and that
 * declaration was then thrown away: everything downstream judged the window as if nobody had said
 * what they were expecting. Two measured consequences, one bug:
 *
 *  - An error path can be declared exactly — `{ net, POST, /api/login, status: 500 }` — and the
 *    contradiction hunter still reported `ui-advanced-request-failed`, because a failed request plus
 *    a moved DOM is all it can see. The failure was EXPECTED and said so in the predicate, so a
 *    verdict of "channels disagree" is a statement about a disagreement nobody had.
 *  - A destination whose content was asserted and FOUND was still reported as
 *    `route-rendered-nothing`, a clause the element evidence beside it disproves.
 *
 * Deliberately conservative about what counts as declared. Only what the caller REQUIRED is read:
 * the top level and `allOf` chains. An `anyOf` branch may never have held, and a `not` declares the
 * opposite of a consequence — honouring either would suppress a real finding on the strength of
 * something that never happened. Pure: a predicate in, a description out.
 */

import { PredicateKind } from '@reticlehq/core';
import type { Predicate } from './predicate-eval.js';

/** A failing call the caller named in advance — matched against the window's real calls. */
export interface DeclaredNetFailure {
  method?: string;
  urlContains?: string;
  status?: number;
}

export interface DeclaredExpectations {
  /** Requests the caller declared would FAIL, so failing is the expected outcome, not a disagreement. */
  netFailures: readonly DeclaredNetFailure[];
  /** The caller required something to be ON SCREEN — an element or text, present rather than absent. */
  rendersContent: boolean;
}

/** Below this, a status is a success or a redirect: not a declared failure. */
const FAILURE_STATUS_MIN = 400;

export function declaredExpectations(predicate: Predicate | undefined): DeclaredExpectations {
  const netFailures: DeclaredNetFailure[] = [];
  let rendersContent = false;

  const walk = (p: Predicate): void => {
    switch (p.kind) {
      case PredicateKind.ALL_OF:
        for (const child of p.predicates) walk(child);
        return;
      case PredicateKind.NET: {
        const declaredFailure =
          false === p.ok || (p.status !== undefined && p.status >= FAILURE_STATUS_MIN);
        if (!declaredFailure) return;
        netFailures.push({
          ...(p.method === undefined ? {} : { method: p.method }),
          ...(p.urlContains === undefined ? {} : { urlContains: p.urlContains }),
          ...(p.status === undefined ? {} : { status: p.status }),
        });
        return;
      }
      case PredicateKind.ELEMENT:
      case PredicateKind.TEXT:
        if (true !== p.absent) rendersContent = true;
        return;
      default:
        return;
    }
  };

  if (predicate !== undefined) walk(predicate);
  return { netFailures, rendersContent };
}

/**
 * Does a call the window recorded match a failure the caller declared?
 *
 * Every field the caller named must agree — a declaration about `POST /api/login → 500` says nothing
 * about `POST /api/orders`, and treating it as a blanket amnesty for failed requests would remove
 * the check rather than inform it. Fields the caller left out are not constraints.
 */
export function matchesDeclaredFailure(
  call: { method: string; url: string; status: number | undefined },
  declared: readonly DeclaredNetFailure[],
): boolean {
  return declared.some((d) => {
    if (d.method !== undefined && d.method.toUpperCase() !== call.method.toUpperCase())
      return false;
    if (d.urlContains !== undefined && !call.url.includes(d.urlContains)) return false;
    if (d.status !== undefined && d.status !== call.status) return false;
    return true;
  });
}

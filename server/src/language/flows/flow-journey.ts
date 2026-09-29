import { createHash } from 'node:crypto';
import { PredicateKind, type FlowFile, type FlowStep, type Predicate } from '@reticlehq/core';

/**
 * One journey, however many times it was driven.
 *
 * Every browser session saves its own flow at teardown, so a journey driven in five sessions was
 * five near-identical files. Two flows are the SAME journey when they start on the same page and
 * take the same steps: same tool, action, anchor and invocation, in the same order. What was typed
 * and what was claimed do not decide it — a re-drive that fills a different value or declares one
 * more consequence is the same journey, better described.
 */

/** The anchor minus its source location, which moves when an unrelated line is edited. */
function anchorShape(anchor: FlowStep['anchor']): unknown {
  const { source: _source, ...rest } = anchor as FlowStep['anchor'] & { source?: unknown };
  return rest;
}

function stepShape(step: FlowStep): unknown {
  return [
    step.tool,
    step.action ?? null,
    anchorShape(step.anchor),
    step.invoke ?? null,
    (step.steps ?? []).map(stepShape),
  ];
}

const FINGERPRINT_LENGTH = 12;

/** A short, stable identity for a journey's shape: its start page and its steps. */
export function journeyFingerprint(flow: Pick<FlowFile, 'startPath' | 'steps'>): string {
  return createHash('sha256')
    .update(JSON.stringify([flow.startPath ?? null, flow.steps.map(stepShape)]))
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/** `kept` wins wherever it says something; `other` fills only what `kept` left unsaid. */
function fillStep(kept: FlowStep, other: FlowStep | undefined): FlowStep {
  if (other === undefined) return kept;
  const merged: FlowStep = { ...other, ...kept };
  if (kept.steps !== undefined) {
    merged.steps = kept.steps.map((sub, i) => fillStep(sub, other.steps?.[i]));
  }
  return merged;
}

/**
 * Fold two copies of one journey into one file.
 *
 * Gap-filling, never overwriting: whatever the kept flow already says — its name, its intent, a
 * step's declared consequence, a quarantine a person wrote — survives, and the other copy only
 * supplies what is missing. So a merge can add an assertion or an intent and can never remove one.
 */
export function mergeJourney(kept: FlowFile, other: FlowFile): FlowFile {
  return {
    ...other,
    ...kept,
    steps: kept.steps.map((step, i) => fillStep(step, other.steps[i])),
  };
}

/**
 * The name a new journey saves under.
 *
 * Its readable name when that is free or already this journey's; otherwise the same name with the
 * fingerprint's head, so two different journeys that share an intent never overwrite each other.
 */
export function journeyName(
  base: string,
  fingerprint: string,
  taken: ReadonlyMap<string, string>,
): string {
  const owner = taken.get(base);
  return owner === undefined || owner === fingerprint ? base : `${base}-${fingerprint.slice(0, 6)}`;
}

/**
 * What must hold before a journey and what it leaves behind, read from where it started and ended.
 *
 * Routes only: the page is the one piece of state every recorded step knows for certain, and a
 * claim written from a guess about the rest would be a precondition nobody met. Written in the
 * exact form `canFollow` compares by value, so A-then-B is answerable from the two files alone.
 */
export function routeClaims(
  startPath: string | undefined,
  steps: readonly FlowStep[],
): { requires?: Predicate[]; ensures?: Predicate[] } {
  const first = startPath ?? steps[0]?.page;
  const last = steps.at(-1);
  const end = last?.endPage ?? last?.page;
  return {
    ...(first === undefined ? {} : { requires: [{ kind: PredicateKind.ROUTE, pathname: first }] }),
    ...(end === undefined ? {} : { ensures: [{ kind: PredicateKind.ROUTE, pathname: end }] }),
  };
}

/**
 * The preconditions only another flow can establish.
 *
 * A route claim on the page the flow starts on is not one of them: replay navigates there itself, so
 * it neither opts the flow out of the reset nor gates the run. That is the claim a saved drive writes
 * for the map (see routeClaims) — reading it as "starts from leftover state" would stop every
 * auto-saved flow from ever being reset.
 */
export function establishedState(flow: FlowFile): readonly Predicate[] {
  const start = flow.startPath;
  return (flow.requires ?? []).filter(
    (claim) =>
      !(
        start !== undefined &&
        PredicateKind.ROUTE === claim.kind &&
        claim.pathname !== undefined &&
        samePath(claim.pathname, start)
      ),
  );
}

/**
 * Is the tab where the flow asked to start? Up to a trailing slash, and up to the query the flow
 * did not ask about.
 *
 * `startPath` is the SPECIFICATION, so it decides what counts. A query it recorded is compared:
 * `?tab=wrap` and `?tab=summary` are different pages, and a replay that starts on the wrong one
 * proves nothing about the right one. A query it did NOT record is ignored: the tab carrying
 * `?next=%2F` on a login page, or the identity params Reticle puts on a leased tab, are not the flow
 * being elsewhere, and navigating to strip them costs a session for nothing.
 *
 * The asymmetry is the whole point and the reason `observed` and `expected` are named rather than
 * `a` and `b`. Comparing with the query on both sides always re-navigated a query-bearing
 * `startPath` (#1059, which killed the session mid-flow); comparing with it on neither side reads a
 * tab on `?tab=summary` as already at `?tab=wrap`.
 */
export function samePath(observed: string, expected: string): boolean {
  const trimmed = (path: string): string => path.replace(/\/$/, '');
  const withoutQuery = (path: string): string => path.replace(/\?[^#]*/, '');
  const comparable = expected.includes('?') ? observed : withoutQuery(observed);
  return trimmed(comparable) === trimmed(expected);
}

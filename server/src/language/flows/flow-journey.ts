import { createHash } from 'node:crypto';
import { PredicateKind, type FlowFile, type FlowStep, type Predicate } from '@reticlehq/core';
import { routePathOf } from '@reticlehq/engine/question/predicate/predicate-route.js';

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

/**
 * Whether `shorter` is `longer` driven with steps left out: same start, and its steps appear in
 * `longer` in the same order. A re-drive that retried a step, or stopped one short, is the same
 * journey; two flows that share only a name and a page are not.
 */
export function withinJourney(
  longer: Pick<FlowFile, 'startPath' | 'steps'>,
  shorter: Pick<FlowFile, 'startPath' | 'steps'>,
): boolean {
  if ((longer.startPath ?? null) !== (shorter.startPath ?? null)) return false;
  const shapes = longer.steps.map((step) => JSON.stringify(stepShape(step)));
  let at = 0;
  for (const step of shorter.steps) {
    const wanted = JSON.stringify(stepShape(step));
    while (at < shapes.length && shapes[at] !== wanted) at += 1;
    if (at === shapes.length) return false;
    at += 1;
  }
  return true;
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
 * A route claim with a `pathname` is not one of them: replay navigates to a declared route itself
 * (see `declaredRoute`), and checks the claim, its `contains` too, once the tab is there (see
 * `unmetRouteClaim`). So a route claim neither opts the flow out of the reset nor gates the run
 * here. The claim on the page the flow starts on is the one a saved drive writes for the map (see
 * routeClaims) — reading it as "starts from leftover state" would stop every auto-saved flow from
 * ever being reset. A route claim on ANOTHER page was read that way, and a suite then ran the flow
 * on whatever page the previous flow left open (#2034).
 */
export function establishedState(flow: FlowFile): readonly Predicate[] {
  return (flow.requires ?? []).filter(
    (claim) => !(PredicateKind.ROUTE === claim.kind && claim.pathname !== undefined),
  );
}

/** A route claim that names a page, with its optional `contains`. */
interface PageClaim {
  pathname: string;
  contains?: string;
}

/**
 * The route claims in `requires` that say more than the flow's `startPath`, in order.
 *
 * A claim on the `startPath` itself is left out: that is the claim every saved drive writes, and
 * replay already arrives there. Every other claim names a page the flow needs (#2034).
 */
function pageClaims(flow: FlowFile): PageClaim[] {
  const start = flow.startPath;
  const claims: PageClaim[] = [];
  for (const claim of flow.requires ?? []) {
    if (PredicateKind.ROUTE !== claim.kind || claim.pathname === undefined) {
      continue;
    }
    if (0 === claim.pathname.length) {
      continue;
    }
    if (start !== undefined && samePath(claim.pathname, start)) {
      continue;
    }
    claims.push({
      pathname: claim.pathname,
      ...(claim.contains === undefined ? {} : { contains: claim.contains }),
    });
  }
  return claims;
}

/**
 * The route a flow declares in `requires` when that says more than its `startPath`: the first
 * such claim, in any order of the claims. Undefined when there is none, and replay then arrives
 * at `startPath` as before. Replay puts the tab on this route before step 1 (#2034).
 */
export function declaredRoute(flow: FlowFile): string | undefined {
  return pageClaims(flow)[0]?.pathname;
}

/**
 * The first declared route claim that the page `observed` does not satisfy, said for a reader.
 * Undefined when they all hold. Each claim is checked whole: its `pathname` by `onRoute`, and its
 * `contains` against the whole route, as the `route` predicate checks it.
 */
export function unmetRouteClaim(flow: FlowFile, observed: string): string | undefined {
  for (const claim of pageClaims(flow)) {
    if (!onRoute(observed, claim.pathname)) {
      return `it is not on ${claim.pathname}`;
    }
    if (claim.contains !== undefined && !observed.includes(claim.contains)) {
      return `its address does not contain "${claim.contains}"`;
    }
  }
  return undefined;
}

/** The mark of a route segment that stands for any one entity id: `:id` in `/cases/:id/notes`. */
const ROUTE_PARAM_MARK = ':';

/** Whether a route segment is a placeholder such as `:id`. */
function isRouteParam(segment: string): boolean {
  return segment.startsWith(ROUTE_PARAM_MARK) && ROUTE_PARAM_MARK.length < segment.length;
}

/** The segments of the path the router is on, without a query or a trailing slash. */
function routerSegments(path: string): string[] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(path, 'http://localhost');
  } catch {
    return undefined;
  }
  return routePathOf(parsed.pathname, parsed.hash).replace(/\/$/, '').split('/');
}

/** Whether a declared route names an entity id with a `:name` segment, for example `/cases/:id/notes`. */
export function isRoutePattern(route: string): boolean {
  return (routerSegments(route) ?? []).some(isRouteParam);
}

/**
 * Is the tab on a declared route?
 *
 * A plain route is compared as `samePath` compares a `startPath`. A pattern is compared segment by
 * segment on the router's path, and a `:name` segment matches any one non-empty segment. The query
 * is not compared for a pattern: the pattern says which page, and the id says which record.
 */
export function onRoute(observed: string, route: string): boolean {
  if (!isRoutePattern(route)) {
    return samePath(observed, route);
  }
  const here = routerSegments(observed);
  const wanted = routerSegments(route);
  if (here === undefined || wanted === undefined || here.length !== wanted.length) {
    return false;
  }
  return wanted.every((segment, i) => {
    const at = here[i] ?? '';
    return isRouteParam(segment) ? 0 < at.length : segment === at;
  });
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

/** The least time replay waits for the SDK to reconnect on the start page. */
const START_PATH_ARRIVAL_TIMEOUT_MS = 5_000;

/**
 * How long replay waits for the start page: the first step's budget when that is longer.
 *
 * A dev server that compiles a route on its first visit can take longer than the floor, and the
 * flow then ended as unverifiable with nothing run. A step the caller let wait 15 s for its
 * consequence can also wait 15 s for its page.
 */
export function startPathBudgetMs(flow: FlowFile): number {
  const first = flow.steps[0]?.timeoutMs ?? flow.signalTimeoutMs ?? 0;
  return Math.max(START_PATH_ARRIVAL_TIMEOUT_MS, first);
}

/**
 * A pattern route with its `:name` segments filled from the page `observed`.
 *
 * A segment is taken only when every segment before it in the route agrees with the page: from
 * `/cases/c-42/files`, the route `/cases/:id/notes` becomes `/cases/c-42/notes`. So another section
 * of the same case keeps the case, and the recorded id, which can be a deleted record, is not used.
 * Undefined when the page has no id to give (`/settings`), or the route has no `:name` segment.
 */
export function fillRouteParams(route: string, observed: string): string | undefined {
  const wanted = routerSegments(route);
  const here = routerSegments(observed);
  if (wanted === undefined || here === undefined) {
    return undefined;
  }
  const values: string[] = [];
  for (const [i, segment] of wanted.entries()) {
    if (!isRouteParam(segment)) {
      continue;
    }
    const agrees = wanted
      .slice(0, i)
      .every((before, j) => isRouteParam(before) || before === here[j]);
    const value = here[i] ?? '';
    if (!agrees || 0 === value.length) {
      return undefined;
    }
    values.push(value);
  }
  if (0 === values.length) {
    return undefined;
  }
  let next = 0;
  return route.replace(/(?<=\/):[^/?#]+/g, (param) => {
    const value = values[next] ?? param;
    next += 1;
    return value;
  });
}

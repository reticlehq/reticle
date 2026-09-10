/**
 * Element and text predicates: everything that resolves a locator against the live DOM.
 *
 * Split out of `predicate.ts` when it crossed the file cap. It is a cohesive unit on its own terms —
 * one round-trip protocol (`matchOnce`), the fields the browser locator drops and this side enforces
 * back (`residualQueryChecks`), the absent/present asymmetry, and the near-miss diagnostics that only
 * ever enrich a failure. Nothing else in the predicate layer talks to `ReticleCommand.MATCH`.
 */

import {
  ReticleCommand,
  type ElementDescriptor,
  type ElementQuery,
  type ElementState,
  type MatchResult,
} from '@reticlehq/core';
import {
  residualQueryChecks,
  satisfiesResiduals,
  describeResidual,
  type EvalResult,
} from './predicate-eval.js';
// Type-only, so the cycle back to `predicate.ts` is erased at compile time and never exists at
// runtime. `PredicateSession` is the predicate layer's interface to a session and belongs with the
// evaluator that defines it.
import type { PredicateSession } from './predicate.js';
import { describeTestidMiss } from './testid-near-miss.js';
import { describeSplitTextMiss } from './split-text-miss.js';

export async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
): Promise<MatchResult> {
  const res = await session.command(ReticleCommand.MATCH, { query, state });
  if (!res.ok) return { matched: false, count: 0, elements: [] };
  return (res.result ?? { matched: false, count: 0, elements: [] }) as MatchResult;
}

/**
 * Roles that exist to ANNOUNCE something. An empty one is the container, not the message.
 *
 * Every toast and notification library mounts its live region at boot and never removes it, so a
 * bare `{ role: "alert" }` presence check is satisfied on those apps with nothing on screen — it
 * cannot fail, and a predicate that cannot fail is not a check. Restricted to these roles because
 * they are the ones whose whole purpose is content: an unnamed `img`, `separator` or `progressbar`
 * is an ordinary thing to assert the presence of, and is left alone.
 */
const ANNOUNCEMENT_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'alertdialog',
  'status',
  'log',
  'marquee',
  'timer',
]);

/**
 * The matches that actually carry content, for a query that named none of its own.
 *
 * A `name`, `text` or `testid` in the query is already a specific claim and is never second-guessed
 * here — this only fills the gap left by a query that asked for a role and nothing else.
 */
function substantiveMatches(
  query: ElementQuery,
  elements: readonly ElementDescriptor[],
): readonly ElementDescriptor[] {
  const bareRole =
    query.role !== undefined &&
    query.name === undefined &&
    query.text === undefined &&
    query.testid === undefined;
  if (!bareRole || !ANNOUNCEMENT_ROLES.has(query.role ?? '')) return elements;
  // Nothing described, nothing to judge. `elements` is only the described PREFIX of a match — the
  // browser truncates it, and it can be empty while `count` is not. Calling that hollow would turn a
  // truncation into a verdict, so an unjudgeable set keeps the old answer.
  if (0 === elements.length) return elements;
  return elements.filter((e) => e.name.length > 0 || (e.text ?? '').trim().length > 0);
}

export async function evalElement(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  absent: boolean,
  diagnose: boolean,
): Promise<EvalResult> {
  // Fields the browser's locator would have DROPPED, enforced back here — see residualQueryChecks.
  // Checked before the round-trip when nothing can enforce them: a predicate that cannot be evaluated
  // must say so rather than resolve to whatever the surviving half of it happened to match.
  const residual = residualQueryChecks(query);
  if (residual.unusable.length > 0) {
    const reason =
      `the element locator ignores ${residual.unusable.map((f) => `\`${f}\``).join(', ')} ` +
      `in ${JSON.stringify(query)} — it resolves by the first of by+value, component/source, role, ` +
      'text, label, placeholder, testid, alt that is present, and nothing here can check the rest. ' +
      'Assert them one locator at a time, or move the extra field into the locator';
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  let match = await matchOnce(session, query, state);
  const subject = JSON.stringify(query);
  // A residual narrows the SET; `count` is every match while `elements` is only the described prefix,
  // so a locator broad enough to be truncated cannot be narrowed honestly. Say so instead of guessing.
  if (residual.checks.length > 0 && match.count > match.elements.length) {
    const reason = `${String(match.count)} elements matched ${subject} and only ${String(match.elements.length)} were described, so ${residual.checks.map(([f]) => `\`${f}\``).join(', ')} could not be checked against all of them — narrow the locator`;
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  const kept = match.elements.filter((element) => satisfiesResiduals(element, residual.checks));
  // The locator found something and the dropped fields disagree with it. Reported separately from a
  // plain miss because the fixes are opposite: the element IS there, its value is not what was claimed.
  if (residual.checks.length > 0 && match.matched && 0 === kept.length && !absent) {
    const wanted = residual.checks.map(([f, want]) => `${f}=${JSON.stringify(want)}`).join(', ');
    return {
      pass: false,
      failureReason: `element matching ${subject} is present but ${wanted} does not hold`,
      observed: match.elements
        .map((element) => residual.checks.map(([f]) => describeResidual(element, f)).join(', '))
        .join('; '),
      expected: `an element matching ${subject} with ${wanted}`,
      assertion: `element.${residual.checks[0]?.[0] ?? 'residual'}`,
      evidence: match.elements,
    };
  }
  if (residual.checks.length > 0) {
    match = { ...match, matched: kept.length > 0, count: kept.length, elements: kept };
  }
  // A given-but-missing scope is handled ASYMMETRICALLY, because "absent" and "present" ask different
  // questions of a scope that no longer exists:
  //  - ABSENT: an element is trivially absent from a container that isn't there. This is also the
  //    everyday "wait for the #overlay/#spinner/#modal to disappear" pattern (scope the wait to the
  //    node being removed) — treating scopeMissing as a hard fail there burned the whole timeout and
  //    flipped a correct green to red. So scopeMissing satisfies an absence check.
  //  - PRESENT: you cannot confirm an element is present inside a scope that resolved to nothing, and
  //    silently widening to the whole page is the original false green. So scopeMissing FAILS presence
  //    (on the wait_for path this just keeps polling until the scope appears).
  if (absent) {
    if (true === match.scopeMissing) {
      return { pass: true, evidence: { absent: true, scopeMissing: true } };
    }
    return match.matched
      ? {
          pass: false,
          failureReason: `expected element to be absent but found ${String(match.count)}`,
          observed: `${String(match.count)} element(s) matching ${subject}`,
          expected: `no element matching ${subject}`,
          assertion: 'element.absent',
          evidence: match.elements,
        }
      : { pass: true, evidence: { absent: true } };
  }
  if (true === match.scopeMissing) {
    return {
      pass: false,
      failureReason: `scope resolved to no element — cannot confirm ${subject} is present`,
      observed: 'the requested scope is not on the page (unmounted or selector matched nothing)',
      expected: `an element matching ${subject} within an existing scope`,
      assertion: 'element.present',
      evidence: { scopeMissing: true },
    };
  }
  const announced = substantiveMatches(query, match.elements);
  if (match.matched && (announced.length > 0 || 0 === match.elements.length)) {
    return { pass: true, evidence: announced };
  }
  // Matched, but every match was a mounted-and-empty live region. Reported as its own failure rather
  // than the plain miss below, because the fixes are opposite: the container IS on the page, so
  // "no element matched" would send the caller looking for a render that already happened.
  if (match.matched) {
    return {
      pass: false,
      failureReason:
        `${String(match.count)} element(s) matched ${subject}, and every one is empty — ` +
        'a live region mounted with no name and no text has announced nothing. Assert the ' +
        'message itself (a `name` or `text` in the query) rather than the container',
      observed: `${String(match.count)} empty '${query.role ?? ''}' region(s) with no name or text`,
      expected: `a '${query.role ?? ''}' carrying a name or rendered text`,
      assertion: 'element.announced',
      evidence: match.elements,
    };
  }

  // The near-miss diagnostic below costs one or two EXTRA MATCH round-trips. It only enriches a FAILED
  // verdict, and a wait loop's interim rechecks read nothing but `pass` — so on the poll path (diagnose
  // false) skip straight to the plain fail. Under an event flood a role+name element wait was firing
  // two live-DOM scans per recheck for a diagnostic no interim eval ever reads; the final timeout eval
  // still runs with diagnose=true and produces the full near-miss.
  if (!diagnose) {
    return {
      pass: false,
      failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      observed: 'no matching element on the page',
      expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      assertion: 'element.present',
    };
  }

  // Diagnostic near-miss: was it there but in the wrong state, or a similar element present?
  if (state !== undefined) {
    const relaxed = await matchOnce(session, query, undefined);
    if (relaxed.matched) {
      return {
        pass: false,
        failureReason: `element exists but not in state '${state}'`,
        observed: `element matching ${subject} is present, states: ${
          relaxed.elements[0]?.states.join(', ') ?? 'unknown'
        }`,
        expected: `element matching ${subject} in state '${state}'`,
        assertion: 'element.state',
        evidence: { nearMiss: relaxed.elements },
      };
    }
  }
  if (query.role !== undefined && query.name !== undefined) {
    const roleOnly = await matchOnce(session, { role: query.role }, state);
    if (roleOnly.matched) {
      return {
        pass: false,
        failureReason: `no '${query.role}' named '${query.name}'; saw: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        observed: `${String(roleOnly.count)} '${query.role}' element(s), named: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        expected: `a '${query.role}' named '${query.name}'`,
        assertion: 'element.role+name',
        evidence: { nearMiss: roleOnly.elements },
      };
    }
  }
  // The testid near-miss: name what IS here, so a typo is one step from fixed rather than a dead
  // end. reticle_query has always done this; the predicate path had no equivalent. See
  // testid-near-miss.ts.
  const present = match.hint?.presentTestids ?? [];
  const alsoHere =
    query.testid === undefined ? undefined : describeTestidMiss(query.testid, present);
  // A text miss where the string is on the page but split across children reads exactly like an
  // element that never rendered. Naming the container is the difference between a retry and a bug
  // report against working code. See split-text-miss.ts.
  const splitText = describeSplitTextMiss(match.hint?.splitText, query.text);
  const clause = splitText ?? (alsoHere === undefined || '' === alsoHere ? undefined : alsoHere);
  const suffix = clause === undefined ? '' : ` — ${clause}`;
  return {
    pass: false,
    failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}${suffix}`,
    observed: `no matching element on the page${suffix}`,
    expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
    assertion: 'element.present',
    ...(present.length > 0 ? { evidence: { presentTestids: present } } : {}),
  };
}

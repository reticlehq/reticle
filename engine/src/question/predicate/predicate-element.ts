/**
 * Element and text predicates: everything that resolves a locator against the live DOM.
 *
 * Split out of `predicate.ts` when it crossed the file cap. It is a cohesive unit on its own terms —
 * one round-trip protocol (`matchOnce`), the fields the browser locator drops and this side enforces
 * back (`residualQueryChecks`), the absent/present asymmetry, and the near-miss diagnostics that only
 * ever enrich a failure. Nothing else in the predicate layer talks to `ReticleCommand.MATCH`.
 */

import {
  MatchArg,
  QueryBy,
  ReticleCommand,
  type ElementDescriptor,
  type ElementQuery,
  ElementState,
  type MatchResult,
} from '@reticlehq/core';
import {
  describeAltOnNonImage,
  describeUnusableElementQuery,
  residualQueryChecks,
  withAltProjected,
  satisfiesResiduals,
  describeResidual,
  type EvalResult,
} from './predicate-eval.js';
// Type-only, so the cycle back to `predicate.ts` is erased at compile time and never exists at
// runtime. `PredicateSession` is the predicate layer's interface to a session and belongs with the
// evaluator that defines it.
import type { PredicateSession } from './predicate-session.js';
import { describeTestidMiss } from './testid-near-miss.js';
import { describeCaseMiss, describeSplitTextMiss } from './split-text-miss.js';
import { satisfiesProperty, type Baseline, type PropertyAssertion } from './property.js';
import { describeNameNearMiss } from './name-near-miss.js';

export const ARIA_HIDDEN_NOTE =
  'text is inside an aria-hidden subtree — drawn on screen but excluded from the accessible tree';

/**
 * HTML tag names mapped to the ARIA role that `getRole` gives them. A query like `{ role: "iframe" }`
 * always returns zero results because `iframe` is a tag, not a role. The map names the correct role
 * so the hint can say exactly what to use instead.
 */
export const HTML_TAG_TO_ARIA_ROLE = new Map([
  ['iframe', 'generic'],
  ['div', 'generic'],
  ['span', 'generic'],
  ['video', 'generic'],
  ['audio', 'generic'],
  ['canvas', 'generic'],
  ['embed', 'generic'],
  ['object', 'generic'],
  ['input', 'textbox'],
  ['textarea', 'textbox'],
  ['a', 'link'],
  ['select', 'combobox'],
  ['nav', 'navigation'],
  ['li', 'listitem'],
  ['ul', 'list'],
  ['ol', 'list'],
  ['p', 'paragraph'],
  ['h1', 'heading'],
  ['h2', 'heading'],
  ['h3', 'heading'],
  ['h4', 'heading'],
  ['h5', 'heading'],
  ['h6', 'heading'],
  ['header', 'banner'],
  ['footer', 'contentinfo'],
  ['aside', 'complementary'],
  ['section', 'region'],
]);

/**
 * When the query's role is a raw HTML tag name, name the correct ARIA role to use instead.
 * Context-dependent tags state the condition so the hint is never wrong.
 */
function describeUnreachableRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  const tag = role.toLowerCase();
  const ariaRole = HTML_TAG_TO_ARIA_ROLE.get(tag);
  if (ariaRole === undefined) return undefined;
  if ('section' === tag) {
    return (
      `'section' is not an ARIA role — ` +
      `a named <section> (with aria-label, aria-labelledby, or title) has role 'region'; ` +
      `an unnamed one has role 'generic'`
    );
  }
  if ('a' === tag) {
    return `'a' is not an ARIA role — <a> elements have role 'link' when they carry an href, otherwise 'generic'`;
  }
  if ('select' === tag) {
    return `'select' is not an ARIA role — <select> elements have role 'combobox', or 'listbox' when the multiple attribute is set`;
  }
  if ('input' === tag) {
    return (
      `'input' is not an ARIA role — <input> role depends on its type attribute: ` +
      `'textbox' for text/email/url/password, 'checkbox', 'radio', 'button', or 'slider' for range`
    );
  }
  if ('generic' === ariaRole) {
    return `'${role}' is not an ARIA role — <${role}> elements have role 'generic'; try { role: 'generic' } with a name or title, or use a testid`;
  }
  return `'${role}' is not an ARIA role — <${role}> elements have role '${ariaRole}'; try { role: '${ariaRole}' }`;
}

/**
 * The caveat for a present-testid list that was cut at its cap, or nothing when it was whole.
 *
 * Phrased as what the list IS — "the first N of M in document order" — rather than as an apology,
 * because the agent's next move depends on knowing the shape: a region absent from a capped list is
 * unexamined, not absent. Empty when nothing was cut, so an ordinary miss keeps the message it had.
 */
function describePresentTestidsCut(shown: number, total: number | undefined): string {
  if (total === undefined || total <= shown) return '';
  return ` (the present-testid list shows the first ${String(shown)} of ${String(total)} in document order — absence from it proves nothing)`;
}

/**
 * Why an `absent` check failed. `absent` means removed from the DOM, so an element the app hid but
 * kept mounted still fails it, correctly. But "found 1" beside `visible: false` evidence reads as a
 * stuck UI, so when every match is hidden the reason says so and names `state: "hidden"`, the
 * predicate for "no longer shown" (#1360). Only when every match was described: with a truncated
 * list a visible one may be among the rest, and the hint would then be wrong. And only when the
 * check names no state: with `state: "hidden"` the advice would repeat the check itself, and with any
 * other state it would ask the caller to drop the condition they actually wrote.
 */
function describeAbsentMiss(match: MatchResult, state: ElementState | undefined): string {
  const found = `expected element to be absent but found ${String(match.count)}`;
  const allDescribedHidden =
    undefined === state &&
    match.elements.length > 0 &&
    match.elements.length === match.count &&
    match.elements.every((element) => !element.visible);
  if (!allDescribedHidden) return found;
  const which = 1 === match.count ? 'it is' : 'every one is';
  return (
    `${found}, but ${which} hidden — \`absent\` means removed from the DOM; ` +
    `to assert it isn't shown, use \`state: "${ElementState.HIDDEN}"\``
  );
}

/**
 * Why a match under a framework error dialog proves nothing. The element is in the DOM, but a user
 * sees only the dialog, so a `yes` here was a false green (#1768).
 */
function describeCovered(dialog: string): string {
  return (
    `a ${dialog} covers the page, so a user cannot see this match. ` +
    'Read the error in the dialog and fix it, then check again'
  );
}

/** The geometry an element predicate asserts on (#1539): measured in the page, graded here. */
export interface ElementGeometryAsks {
  fullyInViewport?: boolean;
  textClipped?: boolean;
  overlaps?: ElementQuery;
}

async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  diagnose?: boolean,
  geometry?: ElementGeometryAsks,
): Promise<MatchResult> {
  const res = await session.command(ReticleCommand.MATCH, {
    query,
    state,
    ...(true === diagnose ? { diagnose: true } : {}),
    ...(geometry === undefined
      ? {}
      : {
          [MatchArg.GEOMETRY]: true,
          ...(geometry.overlaps === undefined
            ? {}
            : { [MatchArg.OVERLAPS_QUERY]: geometry.overlaps }),
        }),
  });
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

/**
 * The first SDK release that can answer each element state added after the vocabulary was first
 * published. A page built before it never finds the name in its state list, so it reports the state
 * as not held, and an `absent` check on it passes whatever the page shows.
 */
const ELEMENT_STATE_SINCE: Readonly<Partial<Record<ElementState, string>>> = {
  // The key is checked against ElementState by the Record type, so a misspelt state cannot compile.
  pressed: '3.4.0',
};

/** Leading `major.minor.patch` as numbers; a pre-release of a version counts as that version. */
function versionParts(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return null === m ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether the page's SDK is older than `since`. An unknown or unreadable version is not. */
function sdkPredates(sdk: string | undefined, since: string): boolean {
  const have = sdk === undefined ? undefined : versionParts(sdk);
  const need = versionParts(since);
  if (have === undefined || need === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] ?? 0) < (need[i] ?? 0);
  }
  return false;
}

/** The state, when the page's SDK is older than the first release that answers it. */
function stateTheSdkPredates(
  sdk: string | undefined,
  state: ElementState | undefined,
): { sdk: string; state: ElementState; since: string } | undefined {
  const since = state === undefined ? undefined : ELEMENT_STATE_SINCE[state];
  if (sdk === undefined || state === undefined || since === undefined) return undefined;
  return sdkPredates(sdk, since) ? { sdk, state, since } : undefined;
}

/** The first SDK release whose element query accepts `matchCase`; an older page refuses the query. */
const MATCH_CASE_SINCE = '3.7.0';

/** A measured box, the way a failure message prints it. */
function formatBox(box: { x: number; y: number; width: number; height: number }): string {
  return `{ x: ${String(box.x)}, y: ${String(box.y)}, width: ${String(box.width)}, height: ${String(box.height)} }`;
}

/**
 * Grade the geometry asks against the described matches, or return undefined when one element
 * satisfies all of them (#1539).
 *
 * The failure names the measured box and, for clipping, the overflow amounts: "not fully in
 * viewport" with no numbers sends the caller to measure by hand, which is the fallback this
 * feature replaces. A match whose descriptors carry no geometry was measured by a page that
 * cannot answer — inconclusive, not a verdict in either direction.
 */
function checkGeometry(
  elements: readonly ElementDescriptor[],
  asks: ElementGeometryAsks,
  subject: string,
): EvalResult | undefined {
  const measured = elements.filter((element) => element.geometry !== undefined);
  if (0 === measured.length) {
    const reason =
      0 === elements.length
        ? `elements matching ${subject} were found but none were described, so their geometry could not be checked`
        : `the page reported no geometry for the element matching ${subject} — a page whose SDK predates the geometry fields cannot measure it, so the check cannot be graded`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.geometry',
    };
  }
  const satisfies = (element: ElementDescriptor): boolean => {
    const geometry = element.geometry;
    if (geometry === undefined) return false;
    if (asks.fullyInViewport !== undefined && geometry.fullyInViewport !== asks.fullyInViewport)
      return false;
    if (asks.textClipped !== undefined && geometry.textClipped !== asks.textClipped) return false;
    if (asks.overlaps !== undefined && true !== geometry.overlap?.intersects) return false;
    return true;
  };
  if (measured.some(satisfies)) return undefined;

  const first = measured[0];
  const geometry = first?.geometry;
  if (first === undefined || geometry === undefined) {
    return {
      pass: false,
      failureReason: `geometry for ${subject} could not be graded`,
      inconclusive: `geometry for ${subject} could not be graded`,
      assertion: 'element.geometry',
    };
  }
  const box = formatBox(geometry.box);
  if (asks.fullyInViewport !== undefined && geometry.fullyInViewport !== asks.fullyInViewport) {
    const reason =
      true === asks.fullyInViewport
        ? `element matching ${subject} is not fully in the viewport: its box is ${box} in a ${String(geometry.viewport.width)}x${String(geometry.viewport.height)} viewport`
        : `element matching ${subject} is fully in the viewport (box ${box}), but the predicate asked for fullyInViewport: false`;
    return {
      pass: false,
      failureReason: reason,
      observed: `box ${box} in a ${String(geometry.viewport.width)}x${String(geometry.viewport.height)} viewport`,
      expected: `an element matching ${subject} with fullyInViewport: ${String(asks.fullyInViewport)}`,
      assertion: 'element.fullyInViewport',
      evidence: measured,
    };
  }
  if (asks.textClipped !== undefined && geometry.textClipped !== asks.textClipped) {
    const reason =
      true === geometry.textClipped
        ? `text of the element matching ${subject} is clipped by ${String(geometry.clippedX)}px horizontally and ${String(geometry.clippedY)}px vertically (box ${box})`
        : `text of the element matching ${subject} is not clipped (box ${box}), but the predicate asked for textClipped: true`;
    return {
      pass: false,
      failureReason: reason,
      observed: `clipped by ${String(geometry.clippedX)}px horizontally, ${String(geometry.clippedY)}px vertically`,
      expected: `an element matching ${subject} with textClipped: ${String(asks.textClipped)}`,
      assertion: 'element.textClipped',
      evidence: measured,
    };
  }
  // The overlaps ask is the only one left, and no measured element satisfied it.
  const overlap = geometry.overlap;
  if (overlap === undefined) {
    // The query matched no visible element: a different fact from the boxes not intersecting,
    // and under `not` a plain failure here would become a pass. Inconclusive instead (#1539).
    const reason = `the overlaps query ${JSON.stringify(asks.overlaps)} matched no visible element, so overlap with ${subject} could not be confirmed`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.overlaps',
      evidence: measured,
    };
  }
  const reason = `the element matching ${subject} (box ${box}) does not overlap the element matching ${JSON.stringify(asks.overlaps)} (box ${formatBox(overlap.box)})`;
  return {
    pass: false,
    failureReason: reason,
    observed: `box ${box}`,
    expected: `an element matching ${subject} overlapping ${JSON.stringify(asks.overlaps)}`,
    assertion: 'element.overlaps',
    evidence: measured,
  };
}

export async function evalElement(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  absent: boolean,
  diagnose: boolean,
  geometry?: ElementGeometryAsks,
): Promise<EvalResult> {
  // Geometry asks grade a match the locator found; with `absent: true` there is no match to
  // grade and the absent branch returns before `checkGeometry`, so the asks would be silently
  // ignored. Refuse the combination instead of answering a question nobody asked (#1539).
  if (absent && geometry !== undefined) {
    const reason =
      'geometry asks (fullyInViewport, textClipped, overlaps) cannot be graded with absent: true: ' +
      'there is no element to measure. Drop the geometry fields or assert on a present element';
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.geometry',
    };
  }
  const tooOld = stateTheSdkPredates(session.sdkVersion, state);
  if (tooOld !== undefined) {
    const reason =
      `the page's SDK is ${tooOld.sdk}, and the '${tooOld.state}' state needs ${tooOld.since} or ` +
      `newer: an older page cannot see it and would report it as not held. Update the page's ` +
      `@reticlehq packages to ${tooOld.since} or newer`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: `SDK ${tooOld.sdk}`,
      expected: `SDK ${tooOld.since} or newer, which can answer '${tooOld.state}'`,
      assertion: 'element.state',
    };
  }
  // Fields the browser's locator would have DROPPED, enforced back here — see residualQueryChecks.
  // Checked before the round-trip when nothing can enforce them: a predicate that cannot be evaluated
  // must say so rather than resolve to whatever the surviving half of it happened to match.
  const residual = residualQueryChecks(query);
  if (residual.unusable.length > 0) {
    const reason = describeUnusableElementQuery(query, residual.unusable);
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  let match = await matchOnce(
    session,
    withAltProjected(query, residual.checks),
    state,
    diagnose,
    geometry,
  );
  const subject = JSON.stringify(query);
  // A residual narrows the SET; `count` is every match while `elements` is only the described prefix,
  // so a locator broad enough to be truncated cannot be narrowed honestly. Say so instead of guessing.
  if (residual.checks.length > 0 && match.count > match.elements.length) {
    const reason = `${String(match.count)} elements matched ${subject} and only ${String(match.elements.length)} were described, so ${residual.checks.map(([f]) => `\`${f}\``).join(', ')} could not be checked against all of them — narrow the locator`;
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  // `alt` is only meaningful on an image, and the role that says so is on the matched descriptor, so
  // this cannot be refused before the round-trip the way an uncheckable field is. It runs AFTER the
  // truncation check: judged on a cut-off prefix, "none of these is an image" would be a guess.
  const altRefusal = describeAltOnNonImage(residual.checks, match.elements);
  if (altRefusal !== undefined) {
    return { pass: false, failureReason: altRefusal, inconclusive: altRefusal };
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
          failureReason: describeAbsentMiss(match, state),
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
  // Geometry asks with no match are inconclusive, not a plain miss. The asks name a measurement
  // of an element, and a locator that matched nothing measured nothing. A plain miss under
  // `not` becomes a pass, so `not { element: { testid: "typo" }, overlaps: ... }` would pass
  // on an element that was never there (#1539).
  if (geometry !== undefined && !match.matched) {
    const reason =
      `no element matched ${subject}, so the geometry asks could not be checked: ` +
      'a missing element has no box to measure. Fix the locator, or drop the geometry ' +
      'fields (fullyInViewport, textClipped, overlaps) to assert a plain miss';
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      assertion: 'element.geometry',
    };
  }
  // Geometry asks grade the match the locator found: one element must satisfy all of them, the
  // way one element carries a state. Splitting the asks across two elements would pass a page
  // where no single element is both fully on screen and unclipped.
  if (geometry !== undefined && match.matched) {
    // `count` is every match while `elements` is only the described prefix: grading the
    // prefix under `not` could pass while an undescribed element satisfies the ask. Refuse
    // like the residual checks do above instead of grading a truncated set (#1539).
    if (match.count > match.elements.length) {
      const reason = `${String(match.count)} elements matched ${subject} and only ${String(match.elements.length)} were described, so the geometry asks could not be checked against all of them. Narrow the locator`;
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    const verdict = checkGeometry(match.elements, geometry, subject);
    if (verdict !== undefined) return verdict;
  }
  const announced = substantiveMatches(query, match.elements);
  if (match.matched && (announced.length > 0 || 0 === match.elements.length)) {
    if (match.coveredBy !== undefined) {
      const reason = describeCovered(match.coveredBy);
      return {
        pass: false,
        failureReason: reason,
        inconclusive: reason,
        observed: `element matching ${subject} is in the DOM under the ${match.coveredBy}`,
        expected: `an element matching ${subject} that a user can see`,
        assertion: 'element.covered',
        evidence: announced,
      };
    }
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
    // Nothing on the page has that role at all. The control is often there under ANOTHER role — a
    // contenteditable composer is not a `textbox`, a styled div is not a `button` — and the name is
    // the part the agent got right. Name the controls carrying it, with their real roles, so the
    // retry targets what exists instead of guessing again. A diagnosis only: `pass` stays false.
    const byName = await nearestByName(session, query.name, state);
    if (byName.length > 0) {
      const seen = byName.map(
        (e) =>
          `${'' === e.role ? 'no role' : e.role} "${'' === e.name ? (e.text ?? '') : e.name}" (${e.ref})`,
      );
      return {
        pass: false,
        failureReason: `no '${query.role}' named '${query.name}'; that name is on: ${seen.join(', ')}`,
        observed: `no element has role '${query.role}'; elements named '${query.name}': ${seen.join(', ')}`,
        expected: `a '${query.role}' named '${query.name}'`,
        assertion: 'element.role+name',
        evidence: { nearestByName: byName },
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
  // Same asymmetry one field over: an exact role+name miss reads like an element that never
  // rendered, while the identical failure through reticle_query lists the labels that role really
  // has. The browser computed them on its way to reporting zero. See name-near-miss.ts.
  // Scoped by role in both spellings, as `query.ts` resolves it: `{ by: 'role', value, name }` carries
  // the role in `value`, and without this the sentence said "the page has" for a list the browser had
  // already limited to that role.
  const nearMissRole = QueryBy.ROLE === query.by ? query.value : query.role;
  const nearMiss = describeNameNearMiss(match.hint?.nameNearMiss, query.name, nearMissRole);
  const caseMiss = describeCaseMiss(match.hint?.caseMiss);
  const ariaNote = true === match.hint?.ariaHiddenMatch ? ARIA_HIDDEN_NOTE : undefined;
  const unreachableRole = describeUnreachableRole(nearMissRole);
  const clause =
    caseMiss ??
    splitText ??
    nearMiss ??
    ariaNote ??
    unreachableRole ??
    (alsoHere === undefined || '' === alsoHere ? undefined : alsoHere);
  const suffix = clause === undefined ? '' : ` — ${clause}`;
  // The evidence list is capped in document order, so a region low on the page is exactly what it
  // drops. Handed back with no marker it reads as the whole page, and the field report this came
  // from read a missing detail panel as proof the panel never rendered. Say the cut happened (#793).
  const total = match.hint?.presentTestidsTotal;
  const cut = describePresentTestidsCut(present.length, total);
  return {
    pass: false,
    // The page shows the text in another case. Still a failure — see EvalResult.caseOnlyMiss.
    ...(caseMiss === undefined
      ? {}
      : {
          caseOnlyMiss: true,
          wouldHold: `the same check with ignoreCase: true (the page shows "${match.hint?.caseMiss ?? ''}")`,
        }),
    failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}${suffix}${cut}`,
    observed: `no matching element on the page${suffix}`,
    expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
    assertion: 'element.present',
    // `splitText` rides on the evidence because it is a POSITIVE observation: the browser found the
    // string in the rendered page. `annotateThrottledMiss` reads it so a miss on a backgrounded tab
    // is not blamed on a render that demonstrably happened.
    ...(present.length > 0 || splitText !== undefined || caseMiss !== undefined
      ? {
          evidence: {
            ...(present.length > 0 ? { presentTestids: present } : {}),
            ...(total === undefined || 0 === present.length ? {} : { presentTestidsTotal: total }),
            ...(splitText === undefined ? {} : { splitText: match.hint?.splitText }),
            // Positive too: the page rendered the text, in another case.
            ...(caseMiss === undefined ? {} : { caseMiss: match.hint?.caseMiss }),
          },
        }
      : {}),
  };
}

/**
 * Narrow a passing text match with a PROPERTY of the text it found.
 *
 * Sits here rather than in the evaluator because the descriptors it reads are this module's own
 * output shape, and because it must run only over a match that already held: a property asserted
 * against the text of an element that is not there is a statement about nothing.
 *
 * Several matches are JOINED before the property runs. `scope` + `self` reads one subtree and is
 * the shape this is for; a locator broad enough to return several is asking about the text they
 * make together, and testing only the first would pass on a page where the rest is the failure.
 */
/** The text an element descriptor reported, or ''. Never `String(unknown)` — see `show` in property.ts. */
function textOf(element: unknown): string {
  if ('object' !== typeof element || null === element) return '';
  const value = (element as { text?: unknown }).text;
  return 'string' === typeof value ? value : '';
}

/** The text of every element a passing match described, joined — what a reader sees there. */
export function joinedText(evidence: unknown): string {
  const described = Array.isArray(evidence) ? evidence : [];
  return described.map(textOf).join(' ').trim();
}

export function withTextProperty(
  base: EvalResult,
  assertion: PropertyAssertion,
  subject: string,
  baseline?: Baseline,
): EvalResult {
  if (!base.pass) return base;
  const described = Array.isArray(base.evidence) ? base.evidence : [];
  const text = joinedText(described);
  const result = satisfiesProperty(text, assertion, baseline);
  // Nothing was compared — a relative property with no before-reading. See the twin in `evalState`.
  if (true === result.unevaluated) {
    return { pass: false, failureReason: result.because, inconclusive: result.because };
  }
  if (result.ok) {
    return { pass: true, evidence: { ...{ matched: described }, satisfied: result.because } };
  }
  return {
    pass: false,
    failureReason: `text of ${subject} ${result.because}`,
    observed: `text of ${subject} = ${JSON.stringify(text)}`,
    expected: `text of ${subject} to satisfy ${assertion.property}`,
    assertion: `text.${assertion.property}`,
    evidence: described,
  };
}

/** How many same-name controls a role miss names. */
const MAX_BY_NAME = 3;

/**
 * Elements carrying an accessible name, whatever their role: by label (aria-label, <label>), then by
 * placeholder. The first locator that finds any wins; at most MAX_BY_NAME are named.
 */
async function nearestByName(
  session: PredicateSession,
  name: string,
  state: ElementState | undefined,
): Promise<ElementDescriptor[]> {
  for (const query of [{ label: name }, { placeholder: name }]) {
    const found = await matchOnce(session, query, state);
    if (found.matched) return found.elements.slice(0, MAX_BY_NAME);
  }
  return [];
}

/**
 * The element query a text predicate is evaluated through — one builder for the verdict and its
 * baseline, so the two cannot disagree about what text was asked for.
 *
 * `matchCase` unless the predicate opts out: a check that matched "Saved Priya" against "Saved
 * priya" could never catch a capitalisation defect. An undefined `contains` must not reach the query
 * as `text: undefined` — that is a locator asking for the empty string.
 */
export function textPredicateQuery(
  predicate: {
    contains?: string | undefined;
    ignoreCase?: boolean | undefined;
    scope?: string | undefined;
    self?: boolean | undefined;
  },
  /** The page SDK's version. A page older than MATCH_CASE_SINCE rejects the field outright. */
  sdkVersion?: string,
): ElementQuery {
  // ponytail: an older page compares case-blind, as the engine did before it sent the field; update the SDK for case-exact checks.
  const matchCase = true !== predicate.ignoreCase && !sdkPredates(sdkVersion, MATCH_CASE_SINCE);
  return {
    ...(undefined === predicate.contains
      ? {}
      : { text: predicate.contains, ...(matchCase ? { matchCase: true } : {}) }),
    ...(undefined === predicate.scope
      ? {}
      : { scope: predicate.scope, ...(true === predicate.self ? { self: true } : {}) }),
  };
}

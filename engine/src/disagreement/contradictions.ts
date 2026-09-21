import {
  ContradictionKind,
  EventType,
  REQUEST_SHAPE_FIELD,
  isAbsenceDerived,
  isSameDocument,
  isSameEditEpoch,
  type ReticleEvent,
} from '@reticlehq/core';
import { describeSuperseded } from '@/question/predicate/observed-in-window.js';
import {
  describe,
  isMutating,
  isSameDocumentHashAnchor,
  isSteadyCadence,
  netCall,
  recoveredByRetry,
  splitForeignTraffic,
  type NetCall,
} from './contradiction-evidence.js';
import { findStaleResponses } from './stale-response.js';
import { findBodyFailures } from './body-failures.js';
import { findEchoMismatches } from './echo-mismatch.js';
import { findUnitMismatches } from './unit-mismatch.js';
import { asString } from '@reticlehq/core';
import { matchesDeclaredFailure } from '@/question/declared.js';
import { runRegisteredFolds } from './contradiction-folds.js';
import type {
  Contradiction,
  OwnContradiction,
  ContradictionOptions,
} from './contradiction-types.js';
export type {
  Contradiction,
  OwnContradiction,
  ContradictionOptions,
} from './contradiction-types.js';

/**
 * The contradiction hunter.
 *
 * Every other check reads ONE channel and asks "did something bad happen there?". This asks what a
 * person watching the screen structurally cannot: do the channels DISAGREE? The DOM, the store, the
 * app's own signals, the console and the network arrive in one causally ordered window, so the case
 * where the screen says one thing and the network says the opposite is visible — and that gap is
 * where false greens live, because a screenshot, a DOM assertion and a human all agree there.
 *
 * Pure: a window of events in, findings out. No session, no IO, no clock.
 */

/**
 * What this request CARRIED, as far as the record knows — `undefined` when it does not know.
 *
 * The page's shape fingerprint first: it is present on every request from an instrumented page,
 * including the overwhelming majority where body capture is off. A captured body is the fallback for
 * a realm that records one without a fingerprint (desktop IPC). Neither means the record does not
 * say what this request carried — a body the page could not read as text, or an SDK too old to
 * compute a fingerprint — and that is an ABSENCE of identity, not an identity shared with every
 * other silent request.
 */
function identityOf(event: ReticleEvent): string | undefined {
  const shape = asString(event.data[REQUEST_SHAPE_FIELD]);
  if (shape !== undefined && 0 !== shape.length) return shape;
  const body = asString(event.data['requestBody']);
  return body === undefined || 0 === body.length ? undefined : body;
}

/** Split calls to one endpoint into the sets that sent the same thing. Callers check first that
 * every identity is known; an unknown one would otherwise pool with every other unknown. */
function groupByIdentity<T extends { identity: string | undefined }>(calls: readonly T[]): T[][] {
  const byIdentity = new Map<string, T[]>();
  for (const call of calls) {
    const key = call.identity ?? '';
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), call]);
  }
  return [...byIdentity.values()];
}

function uiAdvanced(events: readonly ReticleEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === EventType.DOM_ADDED ||
      e.type === EventType.DOM_REMOVED ||
      e.type === EventType.DOM_ATTR ||
      e.type === EventType.DOM_TEXT ||
      e.type === EventType.STATE_CHANGE ||
      e.type === EventType.ROUTE_CHANGE,
  );
}

/**
 * State paths/values that read as the app recording a failure rather than hiding one.
 *
 * English-only, and knowingly so — this is the softest edge in the file. It is a fallback for when
 * the structural check below cannot decide, not the primary signal.
 */
const ACKNOWLEDGED = /error|fail|invalid|reject|denied|unable|could not|couldn't/i;

/**
 * Below this length an error string is too generic to be evidence — "no", "err", a bare code — and
 * could coincide with unrelated state text.
 */
const MIN_ECHOED_ERROR_LENGTH = 8;

/**
 * Wording that blames the USER — bad credentials, no permission, wrong input. Distinct from
 * ACKNOWLEDGED, which merely means "a failure was recorded": an app can honestly report a failure
 * ("server error, try again") without misattributing it.
 */
const BLAMES_USER = /denied|invalid|unauthor|forbidden|incorrect|wrong |not allowed|not permitted/i;

/** A server-fault status: the user cannot fix it and should never be asked to. */
const SERVER_FAULT_MIN = 500;

/**
 * Did the app record the failure in its OWN state — the layer the UI renders from?
 *
 * Without this, "the UI moved while a request failed" fires on correct code: a handler that catches
 * the rejection and renders "could not add" also moves the UI. Both look identical at the level of
 * "DOM changed + request failed"; what separates them is whether the app acknowledged the failure
 * anywhere, or silently proceeded as if it had succeeded.
 *
 * Deliberately NOT satisfied by a console error. `console.error` is invisible to the user, so an app
 * that logs and then shows success is still lying to whoever is looking at it — precisely the case
 * worth reporting.
 *
 * A heuristic, and the one soft edge in this file: an app that surfaces failure through a value this
 * pattern does not recognize will produce a finding a human must dismiss. That direction is the safe
 * one — a false alarm costs a glance, a missed false green ships.
 */
function failureAcknowledged(events: readonly ReticleEvent[]): boolean {
  // STRUCTURAL first, and language-independent: if the app put the failed call's OWN error text into
  // its state, it plainly knows the call failed — whatever language it says so in. The lexical
  // patterns below are English-only, so without this a German or Japanese app that surfaces its
  // failure perfectly well would be reported as hiding it.
  const errors = events
    .filter((e) => e.type === EventType.NET_REQUEST && e.data['ok'] !== true)
    .map((e) => asString(e.data['error']))
    .filter((text): text is string => text !== undefined && text.length >= MIN_ECHOED_ERROR_LENGTH);
  const echoesAnError = events.some((e) => {
    if (e.type !== EventType.STATE_CHANGE) return false;
    const value = asString(e.data['value']);
    return value !== undefined && errors.some((text) => value.includes(text));
  });
  if (echoesAnError) return true;

  return events.some((e) => {
    // A failure-shaped SIGNAL is an acknowledgement too. An app that fires `auth:denied` has plainly
    // not proceeded as if it succeeded, whatever its state paths happen to be named.
    if (e.type === EventType.SIGNAL) return ACKNOWLEDGED.test(asString(e.data['name']) ?? '');
    if (e.type !== EventType.STATE_CHANGE) return false;
    const path = asString(e.data['path']) ?? '';
    const value = e.data['value'];
    return ACKNOWLEDGED.test(path) || ('string' === typeof value && ACKNOWLEDGED.test(value));
  });
}

const MUST_DO_SOMETHING = new Set(['click', 'dblclick', 'submit']);

/**
 * Whether NOTHING in this window is attributable to the action.
 *
 * Ambient churn is deliberately not counted as evidence the action worked — a background event
 * stream, a polling store, a perf sample and a scroll position all move on their own. What counts:
 *
 *  - a mutation inside the target's own subtree (what the target itself did),
 *  - a request (the action asked the server for something),
 *  - a navigation, or a dialog/live region appearing — the two ways a real reaction legitimately
 *    lands OUTSIDE the target, e.g. a modal portalled to the body.
 *
 * The last clause is what keeps this from manufacturing noise: a button that opens a modal mutates
 * nothing within itself, and must not be called dead.
 */
function didNothing(
  events: readonly ReticleEvent[],
  requests: readonly NetCall[],
  mutatedWithin: number | undefined,
): boolean {
  if (mutatedWithin === undefined) return 0 === events.length;
  if (mutatedWithin > 0 || requests.length > 0) return false;
  return !events.some(
    (e) => e.type === EventType.ROUTE_CHANGE || e.type === EventType.VISIBLE_SHOWN,
  );
}

/**
 * Was the page HIDDEN at any point in this window?
 *
 * A backgrounded tab has its rAF and timers clamped by the browser, and the DOM observer flushes on
 * rAF — so real mutations are never emitted. The window then looks silent when the app in fact
 * rendered, and every absence-derived rule reads that silence as a fault.
 *
 * MEASURED, not theorised: a crawl over bench-app reported `state-vs-render` on a ⌘K button whose
 * click both committed `paletteOpen: true` and mounted the palette inside `#root`. The recorded
 * window held the store change, the app's own `palette:opened` signal, no DOM event whatsoever, and
 * two `page.health` heartbeats reading `hidden: true`.
 *
 * ANY hidden heartbeat disqualifies the whole window rather than the part after it: the flush that
 * was suppressed could be any of them, and a window that was hidden for part of its life cannot say
 * which part lost events.
 */
function pageWasHidden(events: readonly ReticleEvent[], options: ContradictionOptions): boolean {
  // The caller states it when it knows. A heartbeat landing inside the window is the fallback, not
  // the mechanism — see the option doc for why the window alone cannot be trusted to carry one.
  if (options.pageHidden !== undefined) return options.pageHidden;
  return events.some(
    (e) =>
      e.type === EventType.PAGE_HEALTH &&
      true === (e.data as { hidden?: unknown } | undefined)?.hidden,
  );
}

/** Net-shaped events — the only ones that carry a URL a dev-tooling channel could occupy. */

export function findContradictions(
  allEvents: readonly ReticleEvent[],
  options: ContradictionOptions = {},
): Contradiction[] {
  const all = findWindowContradictions(allEvents, options);
  // Filtered here rather than inside each rule, so a rule added later inherits the guard by being
  // classified absence-derived — the one place that already knows which findings rest on silence.
  // Hiding can only manufacture ABSENCE: a failed request or a contradicting channel is something
  // that WAS seen, so evidence-derived findings are untouched and still report.
  const found = pageWasHidden(allEvents, options)
    ? all.filter((c) => !isAbsenceDerived(c.kind))
    : all;
  const predates =
    allEvents.length > 0 &&
    allEvents.every((e) => !isSameEditEpoch(e.editEpoch, options.currentEditEpoch));
  if (!predates) return found;
  // Prepended, not appended: the caveat governs how everything under it should be read, and it has
  // to survive the rules that return early with a single finding of their own.
  return [
    {
      kind: ContradictionKind.EVIDENCE_PREDATES_EDIT,
      claim: 'these observations describe the code as it is now',
      counter: 'every one of them was recorded before the last hot update landed in the page',
      detail:
        'the source changed and the page re-rendered after this evidence was captured, so it describes code that has since been replaced — nothing here is necessarily wrong, but nothing here has seen the edit either. Drive the app again to verify the current code',
    },
    ...found,
  ];
}

function findWindowContradictions(
  allEvents: readonly ReticleEvent[],
  options: ContradictionOptions,
): Contradiction[] {
  const found: OwnContradiction[] = [];
  const { app: allApp, ignored: ignoredForeign } = splitForeignTraffic(
    allEvents,
    options.appOrigin,
  );

  // ── Evidence belonging to a document that has since been replaced ───────────────────────────
  // Scoped ONCE, here, for the same reason the dev-tooling split is: every rule below asks "what
  // else was in this window", and answering that with a dead page's traffic is a defect in all of
  // them rather than in whichever one reported it. Applied after the dev-tooling split so the count
  // reported below is the app's own evidence and not the toolchain's noise.
  const scoped = allApp.filter((e) => isSameDocument(e.documentId, options.currentDocumentId));
  const superseded = allApp.length - scoped.length;
  // An empty window was always allowed to mean "nothing happened"; that reading is only unsafe once
  // supersession is what emptied it. Reported ALONE and before every rule below, because a window
  // with nothing left in it is exactly the shape `action-had-no-effect` fires on — so without this
  // the fix would have swapped a wrong citation for a wrong accusation.
  if (superseded > 0 && 0 === scoped.length) {
    return [
      {
        kind: ContradictionKind.EVIDENCE_SUPERSEDED,
        claim: 'this window holds observations that could answer for the action',
        counter: describeSuperseded('observations', superseded),
        detail:
          'a full navigation or a reload built a new document, and everything recorded here belongs to the old one — citing it would name requests, errors and state that no longer describe anything on screen',
      },
    ];
  }

  // ── Evidence that predates the action ───────────────────────────────────────────────────────
  // The attribution floor, and it is scoped ONCE here for the same reason the two filters above are:
  // a rule that reads "what else was in this window" and gets handed traffic from before the caller
  // acted is not refining its answer, it is answering about somebody else's action. Three rules
  // (`duplicate-request`, `signal-without-consequence`, `consequence-elsewhere`) each checked this
  // for themselves and the other six swept the whole window — which is how an assert with no `since`
  // came to be judged against everything that had ever happened in the tab.
  //
  // Undefined means nothing attributed the window to an action at all; the floor then does nothing,
  // and the consequence rules below decline to speak instead. See `advanced`.
  const floor = options.actionSince;
  const events = floor === undefined ? scoped : scoped.filter((e) => e.t >= floor);

  const settled = events.filter((e) => e.type === EventType.NET_REQUEST).map(netCall);

  // ── Overlapping reads that settled out of order ─────────────────────────────────────────────
  // Independent of any action, so it runs on every window: the race is a property of the timeline.
  found.push(...findStaleResponses(events));

  // ── A 2xx whose BODY says it failed ─────────────────────────────────────────────────────────
  // Needs body capture; silent without it, which is why the assert path also declares when bodies
  // were never recorded rather than letting an unread payload read as an empty one.
  found.push(...findBodyFailures(events));
  found.push(...findEchoMismatches(events, options.actionSince));

  // ── A money value written back at the wrong SCALE ───────────────────────────────────────────
  found.push(...findUnitMismatches(events, options.prior ?? []));

  // ── The action landed on something that does not react ──────────────────────────────────────
  // Checked first and returned alone: nothing is attributable to the action, so every rule below is
  // reasoning about someone else's events.
  const action = (options.action ?? '').toLowerCase();
  if (MUST_DO_SOMETHING.has(action) && didNothing(events, settled, options.mutatedWithin)) {
    const measured = options.mutatedWithin !== undefined;
    return [
      {
        kind: ContradictionKind.ACTION_HAD_NO_EFFECT,
        claim: `the ${action} was dispatched and the page settled`,
        counter: measured
          ? 'nothing changed inside the target, and no request, navigation or dialog followed — whatever else moved on the page was not this'
          : 'no channel observed anything at all — DOM, store, route, network, signal, console',
        detail:
          'the target does not react to this action (a non-interactive wrapper resolved instead of the control, a disabled handler, or a no-op) — settling proves only that the page was quiet, which a page that did nothing always is',
      },
    ];
  }
  // A failure the app RECOVERED from is not evidence against anything.
  //
  // Reported from the field on an app whose api-client documents the pattern every token-refreshing
  // app has: a 401 re-hydrates the session and retries once. One extraction produced a 401 and then
  // a 200 to the same endpoint, with exactly one extraction in state, and Reticle called it two
  // separate contradictions. Both were false, both cost calls to disprove, and a rule that
  // manufactures reds costs more trust than a missed bug does.
  //
  // Structural, not a timing heuristic: what makes it a retry is that a LATER call to the same
  // method and url SUCCEEDED. The write landed, so the UI was entitled to move and a success signal
  // was entitled to fire. Filtered at the definition rather than at the two reading sites, because
  // both rules make the same claim about the same evidence and a fix in one is a fix in half.
  const recovered = recoveredByRetry(settled);
  const failed = settled.filter((c) => false === c.ok && !recovered.has(c));
  // The failures NOBODY declared — see ContradictionOptions.expectedFailures. Only the heuristic
  // "the UI moved while a request failed" rule reads this; the sharp rules still read `failed`.
  const unexpected = failed.filter(
    (c) => !matchesDeclaredFailure(c, options.expectedFailures ?? []),
  );
  /**
   * Did the UI move — and is anybody entitled to say so?
   *
   * `undefined` is the third answer and the point of the tri-state: "the UI moved forward while a
   * request failed" is a claim about CAUSATION, and over a window nothing attributed to an action
   * the two halves merely co-occurred. A passive `reticle_assert` performs nothing, so ambient
   * traffic — a poll, a page-load bootstrap, a branding call — is not its consequence and must not
   * decide its verdict.
   *
   * Typed rather than gated with a boolean so it cannot be skipped: every rule that reasons from UI
   * movement has to answer `undefined` explicitly, including one added later. The rules that read
   * the app's OWN claims (a success signal over a failed call) or its payloads (a 2xx whose body
   * says it failed, a field echoed back wrong) are untouched — those are things the app said, not
   * consequences anybody inferred, and they are true whoever caused them.
   */
  const advanced: boolean | undefined = floor === undefined ? undefined : uiAdvanced(events);
  const signals = events
    .filter((e) => e.type === EventType.SIGNAL)
    .map((e) => asString(e.data['name']) ?? 'signal');

  // ── The route moved and nothing was rendered for it ─────────────────────────────────────────
  // A navigation that neither fetches nor renders arrived nowhere. Distinct from a dead control:
  // the control worked, the DESTINATION is empty — which is why every "did the click do something"
  // heuristic passes it, a route change being unambiguously something.
  const routeEvents = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const routed = routeEvents.length > 0;
  // A skip link (`href="#main-content"`) is a same-document hash change. The observable
  // consequences are location.hash, focus, and scroll — not a DOM mutation. Treating it as a
  // blank destination made "did my skip link work" unanswerable. Hash-router paths (`#/invoices`)
  // still go through the rule: those ARE a new view.
  const hashAnchorOnly = routed && routeEvents.every(isSameDocumentHashAnchor);
  // `dom.text` counts as rendered, and it has to: React reconciles a destination IN PLACE far more
  // often than it adds nodes. Measured on three ordinary sidebar navigations of the bench app — every
  // one emitted { dom.attr:2, dom.text:2, render.commit, state.change } and ZERO dom.added/removed,
  // so all three were flagged as blank destinations, `verified` came back "no" on a correct green,
  // and a bug_found was emitted for a navigation that worked.
  //
  // Deliberately NOT `dom.attr`: the nav link marks itself active whether or not the destination
  // rendered, which is the true positive this rule exists for. Deliberately NOT `render.commit`
  // either: React commits a render for a component that returns null, which is one of the very bugs
  // named in `detail` below.
  const rendered = events.some(
    (e) =>
      e.type === EventType.DOM_ADDED ||
      e.type === EventType.DOM_REMOVED ||
      e.type === EventType.DOM_TEXT,
  );
  const fetched = events.some(
    (e) => e.type === EventType.NET_REQUEST || e.type === EventType.NET_PENDING,
  );
  if (routed && !hashAnchorOnly && !rendered && !fetched && true !== options.renderProved) {
    // A console error in the SAME window turns "nothing rendered" from an absence into a positive
    // claim: the destination did not merely fail to produce content, it crashed while trying to.
    // Reported once as `unknown` when this held — a React hooks error and an empty destination were
    // both in hand, and the honest, definitive answer was available and not given (#897).
    const consoleErrors = events
      .filter((e) => e.type === EventType.CONSOLE_ERROR)
      .map((e) => asString(e.data['message']))
      .filter((m): m is string => undefined !== m && m.length > 0);
    if (consoleErrors.length > 0) {
      found.push({
        kind: ContradictionKind.ROUTE_RENDERED_NOTHING_CRASHED,
        claim: 'the app navigated to a new route',
        counter: `nothing was rendered for it, and the console shows why: ${consoleErrors[0] ?? ''}`,
        detail:
          `the URL moved but the destination produced no content, and the same window logged ` +
          `${String(consoleErrors.length)} console error(s) — the first: "${consoleErrors[0] ?? ''}". ` +
          'The destination crashed rather than merely rendering nothing; read the error for the ' +
          'component and line at fault.',
      });
    } else {
      found.push({
        kind: ContradictionKind.ROUTE_RENDERED_NOTHING,
        claim: 'the app navigated to a new route',
        counter: 'nothing was rendered for it — no content added or removed, and no request made',
        detail:
          'the URL moved but the destination produced no content: a route with no view, a view that returned null, or data the page never asked for. A control that navigates always looks alive, so this is invisible to a dead-control check. Confirm by reading the page — a view revealed from DOM that already existed emits this same window',
      });
    }
  }

  // ── The app claimed success while its own request failed ────────────────────────────────────
  // A signal is the sharper claim: the app did not merely LOOK right, it explicitly asserted
  // success. When both hold it is one fact, so only the sharper one is reported.
  // ── The server faulted and the app blamed the user ──────────────────────────────────────────
  // Checked BEFORE the success-claim rules, because it is the sharper reading of the same events:
  // the app did not claim success, it claimed the wrong failure. Telling someone their password is
  // wrong while the backend is down sends them to fix something they cannot fix.
  const serverFaults = settled.filter(
    (c) => false === c.ok && c.status !== undefined && c.status >= SERVER_FAULT_MIN,
  );
  const userBlame = [
    ...signals.filter((name) => BLAMES_USER.test(name)),
    ...events
      .filter((e) => e.type === EventType.STATE_CHANGE)
      .map((e) => asString(e.data['value']) ?? '')
      .filter((value) => BLAMES_USER.test(value)),
  ];
  const misattributed = serverFaults.length > 0 && userBlame.length > 0;
  if (misattributed) {
    found.push({
      kind: ContradictionKind.FAILURE_MISATTRIBUTED,
      claim: `the app told the user they were at fault (${userBlame.map((b) => `"${b}"`).join(', ')})`,
      counter:
        'the server returned a 5xx — the user cannot fix this and the real fault is unreported',
      detail: serverFaults.map(describe).join('; '),
    });
  }

  // A failure-shaped signal is not a success claim, so it must not be read as one: saying "the app
  // claimed success" about an app that plainly reported a failure is true in outline and wrong in
  // its reasoning, which is how a checker stops being believed.
  const successSignals = signals.filter((name) => !ACKNOWLEDGED.test(name));
  // An app that RETRACTED has not claimed success, whenever it fired the optimistic signal.
  //
  // The weaker UI rule below already consulted this and the sharper signal rule did not, so an app
  // that announced "ack:requested", met a 500, and then correctly emitted "ack:failed" and rolled the
  // row back was reported as explicitly asserting success — the strongest accusation this file makes,
  // against code doing exactly the right thing. On a fixture suite the scenario's FIXED twin produced
  // the same finding as the build that swallowed the failure, which makes the finding worthless on
  // the one measurement that scores precision.
  //
  // Ordering cannot decide this: an optimistic UI legitimately fires its success signal BEFORE the
  // response, so "the claim must follow the failure" would miss the real defect. What separates them
  // is not when the app spoke, it is whether it took it back.
  // WHAT failed decides this, not whether an action was attributed.
  //
  // The claim is a thing the app said, so the attribution floor does not apply to it — the flagship
  // false green is an app asserting success on a PASSIVE assert while its own write failed, and
  // requiring an action would lose exactly that. But the COUNTER was any failure in the window, and
  // that is the same window statement scoped out of every other rule here. Measured: two of the
  // three false positives surviving the first scoping pass were this rule.
  //
  // A success signal claims a CHANGE was made. A failed mutation is evidence against that claim; a
  // failed read is not. Background polls, prefetches and telemetry GETs fail constantly in healthy
  // apps and say nothing about whether a write landed. Structural, not a timing heuristic, and the
  // distinction was already encoded next door in `isMutating`.
  const failedWrites = failed.filter(isMutating);
  // The same scoping, for the same reason, one branch down. "The UI moved forward" is also a claim
  // that something CHANGED, and it was still reading ANY failure — so a first-party poll failing
  // during an action contradicted a verdict the action had genuinely earned. Measured on the
  // observation benchmark: one of two false positives across 47 cells, and the argument for it is
  // the paragraph above, which had simply not been carried down here.
  const unexpectedWrites = unexpected.filter(isMutating);
  if (failedWrites.length > 0 && successSignals.length > 0 && !failureAcknowledged(events)) {
    found.push({
      kind: ContradictionKind.SIGNAL_CONTRADICTED,
      claim: `the app fired ${successSignals.map((s) => `"${s}"`).join(', ')}`,
      counter: `${String(failedWrites.length)} write(s) in the same window failed`,
      detail: failedWrites.map(describe).join('; '),
    });
  } else if (
    unexpectedWrites.length > 0 &&
    true === advanced &&
    !misattributed &&
    !failureAcknowledged(events)
  ) {
    found.push({
      kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
      claim: 'the UI moved forward (DOM/store/route changed)',
      counter: `${String(unexpectedWrites.length)} request(s) in the same window failed`,
      detail: unexpectedWrites.map(describe).join('; '),
    });
  }

  // ── A write succeeded and nothing on the client moved ───────────────────────────────────────
  // Writes only: a GET that changes nothing is a prefetch; a POST that changes nothing is a lost
  // write, a response parsed into the void, or a render that never happened.
  if (false === advanced) {
    const ignoredWrites = settled.filter((c) => true === c.ok && isMutating(c));
    if (ignoredWrites.length > 0) {
      // ...unless THIS document handed the consequence to another browsing context. An OAuth sign-in
      // posts, succeeds, and continues in a popup the in-page SDK cannot follow (#508): the original
      // tab legitimately never changes, and response-ignored would accuse it of ignoring a response
      // it handed off. The opened-context event flips the reading from "the client did nothing" to
      // "the client went where we cannot look". Scoped like every rule here to the attribution floor
      // (`options.actionSince`; the local below is declared later, for the window rules).
      const contextFloor = options.actionSince;
      const openedContext = events.some(
        (e) =>
          e.type === EventType.CONTEXT_OPENED && contextFloor !== undefined && e.t >= contextFloor,
      );
      found.push(
        openedContext
          ? {
              kind: ContradictionKind.CONSEQUENCE_ELSEWHERE,
              claim: `${String(ignoredWrites.length)} write(s) succeeded on the server`,
              counter:
                'this document never changed because the page opened another browsing context during this window (e.g. an OAuth popup), where the in-page SDK cannot observe the result',
              detail: ignoredWrites.map(describe).join('; '),
            }
          : {
              kind: ContradictionKind.RESPONSE_IGNORED,
              claim: `${String(ignoredWrites.length)} write(s) succeeded on the server`,
              counter: 'nothing on the client changed — no DOM, store or route movement',
              detail: ignoredWrites.map(describe).join('; '),
            },
      );
    }
  }

  // ── The store committed and the screen never moved ─────────────────────────────────────────
  //
  // Scoped as tightly as the one below, and for the same reason: it fires on an ABSENCE, which is
  // the easiest way to build a false positive. Only for a window attributed to an ACTION, only when
  // state actually moved, only when NO DOM node moved with it, and only when nothing is still in
  // flight that the render could legitimately be waiting on.
  //
  // Route movement counts as the screen moving: a navigation IS a render, and a store change that
  // drives one has been corroborated.
  //
  // And only when the window carries NO NETWORK AT ALL. A request means the app reached for
  // something, and whether it failed, was ignored or never settled already belongs to three other
  // rules — firing here as well would report one fact twice, which is exactly the scoping the
  // signal rule below had to earn. Two existing tests proved it: both describe a window with a
  // failed call in it, and both were already answered by the rule that owns that fact.
  if (
    options.actionSince !== undefined &&
    events.some((e) => e.type === EventType.STATE_CHANGE) &&
    !events.some((e) => e.type === EventType.NET_REQUEST || e.type === EventType.NET_PENDING) &&
    !events.some(
      (e) =>
        e.type === EventType.DOM_ADDED ||
        e.type === EventType.DOM_REMOVED ||
        e.type === EventType.DOM_ATTR ||
        e.type === EventType.DOM_TEXT ||
        e.type === EventType.ROUTE_CHANGE,
    )
  ) {
    found.push({
      kind: ContradictionKind.STATE_VS_RENDER,
      claim: 'the store committed a change',
      counter:
        'nothing rendered in the same window — no DOM node added, removed or changed, and no ' +
        'route movement, with no request still in flight the render could be waiting on',
      detail:
        'a component that does not re-render on a committed change shows the OLD value while the ' +
        'app is internally consistent, which is why nothing else reports it',
    });
  }

  // ── The app announced a consequence and nothing else moved ─────────────────────────────────
  // Scoped as tightly as the evidence allows, because this rule fires on the ABSENCE of everything
  // else and that is the easiest way to build a false positive.
  //
  // Only when the window is otherwise EMPTY: no DOM, no store, no route (`!advanced`) and no request
  // at all. A request means the app reached for something, and whether it settled, failed or was
  // ignored belongs to three other rules — firing here too would report one fact twice.
  //
  // `successSignals` reuses the failure-shaped filter above: an app that announced `deploy:failed`
  // is correctly reporting that nothing happened, and accusing it inverts the meaning of the one app
  // doing this right.
  //
  // And only for a window attributed to an ACTION. `reticle_assert` OBSERVES — there is no click
  // whose consequence should have corroborated anything, so an assert over a quiet window carrying
  // one signal is an ordinary read, not a claim nothing backs. Without this the rule reddened eight
  // existing tests that assert exactly that, which is the false-positive class this scoping exists
  // to prevent.
  if (
    options.actionSince !== undefined &&
    false === advanced &&
    0 === settled.length &&
    successSignals.length > 0
  ) {
    found.push({
      kind: ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
      claim: `the app fired ${successSignals.map((s) => `"${s}"`).join(', ')}`,
      counter:
        'nothing else in the window moved — no DOM, no store, no route, no request — so the only ' +
        'evidence that anything happened is the app saying so',
      detail:
        'a signal emitted from the value the app was ASKED for, rather than the one it committed, ' +
        'reads identically to one that worked',
    });
  }

  // ── The same write fired more than once, inside ONE action's window ─────────────────────────
  // Attribution is the whole rule here, not a refinement of it: counting `method + url` over whatever
  // window the caller handed in turns two legitimate separate saves into a double submit. See
  // ContradictionOptions.actionSince.
  //
  // What the request CARRIED joins the identity. A command-bus API posts every mutation to one URL
  // and discriminates on a body field (`{"command":"study.stage.set"}` vs `{"command":"mesh.plan"}`),
  // and a submit that intentionally saves and then advances sends two different payloads to the same
  // endpoint; under URL alone each of those distinct writes read as a repeat of the first, and clean
  // verdicts degraded to unknown behind doubles that were never doubles.
  //
  // The discriminator is `REQUEST_SHAPE_FIELD` — a fingerprint of the body's shape that the page can
  // compute with body capture OFF, which is the configuration every session runs in. A captured body
  // is used when there is one and no fingerprint (a realm that records bodies but not shapes).
  //
  // When NEITHER is on the record for any call at a URL, the identity of those writes is not known,
  // and this used to be answered inconsistently and silently: two calls that both lacked a body got
  // the same key and were reported as a duplicate, while two where only ONE carried a body got
  // different keys and were reported as nothing at all — so the guess went one way on a false
  // positive and the other way on a real double submit. An unknown group is now one group, reported
  // with a finding that SAYS the identity could not be established. That is `unknown`, which is the
  // honest verdict for it, rather than `unknown` dressed as an accusation.
  const actionSince = options.actionSince;
  if (actionSince !== undefined) {
    /**
     * When the window navigated, and therefore when a write stops belonging to the user's action.
     *
     * React StrictMode double-invokes a mount effect in development, so clicking a nav link lands
     * two identical writes inside the action's own window. Nothing scoped them out and they read as
     * a double submit — measured on the observation benchmark as one of two false positives.
     *
     * The route change is the structural tell, not a heuristic: the claim this rule makes is "one
     * user action was performed", and writes that follow a navigation belong to the mount of the
     * view navigated TO. A real double submit fires from the view it is already on, with nothing in
     * between — and one that navigates AFTER submitting is still counted, because the order is what
     * distinguishes them.
     */
    const navigatedAt = events.find(
      (e) => EventType.ROUTE_CHANGE === e.type && e.t >= actionSince,
    )?.t;
    const writes = new Map<
      string,
      { t: number; landed: boolean; identity: string | undefined }[]
    >();
    for (const event of events) {
      if (event.type !== EventType.NET_REQUEST || event.t < actionSince) continue;
      if (navigatedAt !== undefined && event.t >= navigatedAt) continue;
      const call = netCall(event);
      if (!isMutating(call)) continue;
      const label = `${call.method} ${call.url}`;
      const calls = writes.get(label) ?? [];
      // `landed` is tracked per call rather than counted here, because the claim is about what
      // APPLIED and a group is only formed once the identities are known.
      calls.push({ t: event.t, landed: false !== call.ok, identity: identityOf(event) });
      writes.set(label, calls);
    }
    /**
     * Did the assertion name this endpoint?
     *
     * `undefined` means the caller declared nothing (a bare `observe`), and with nothing declared
     * nothing is unrelated — every duplicate keeps the behaviour it had. An empty-string entry is a
     * net clause with no `urlContains`, which named the whole channel and therefore matches
     * everything.
     */
    const named = options.namedNetUrls;
    const wasNamed = (label: string): boolean =>
      named === undefined || named.some((u) => label.includes(u));
    for (const [label, calls] of writes) {
      // One unknown identity makes the whole endpoint's traffic one group: the calls that DO have a
      // fingerprint cannot be told apart from the ones that do not, so splitting on it would answer
      // a question the record cannot answer.
      const identified = calls.every((c) => c.identity !== undefined);
      const groups = identified ? [...groupByIdentity(calls)] : [calls];
      for (const group of groups) {
        const times = group.map((c) => c.t);
        const landed = group.filter((c) => c.landed).length;
        if (times.length < 2) continue;
        // A DOUBLE SUBMIT is a write that landed twice. Two attempts of which one failed is a RETRY,
        // and the field case is the commonest retry there is: a 401 that refreshed a token and went
        // again, one row created, reported here as `duplicate-request ×2`. Two attempts that both
        // failed are not a double submit either — nothing applied even once, so the claim "one user
        // action was performed" is not contradicted by them. A call with no verdict at all still
        // counts, because absence of a status is not evidence the write was rejected.
        if (landed < 2) continue;
        // A steady cadence is a POLL, and a poll is not a double submit. An app that polls could not
        // produce a verdict at all: a camera scan loop POSTing until it acquires a lock had every
        // assertion that had already seen its consequence come back `unknown` behind writes that
        // were the app working correctly (#673).
        if (isSteadyCadence(times)) continue;
        // A burst the assertion never mentioned is still worth telling the caller about -- a retry
        // loop or a bursty beacon is a real finding -- but it is not evidence about the consequence
        // they declared, so it is reported and decides nothing. The named case keeps its downgrade:
        // "the write you asked about fired twice" is exactly what this rule is for.
        const related = wasNamed(label);
        const count = String(times.length);
        found.push({
          kind: related
            ? ContradictionKind.DUPLICATE_REQUEST
            : ContradictionKind.DUPLICATE_REQUEST_UNRELATED,
          claim: related
            ? 'one user action was performed'
            : 'the assertion did not name this endpoint',
          counter: identified
            ? `the same write fired ${count} times`
            : `this endpoint was written to ${count} times`,
          detail: identified
            ? `${label} ×${count}`
            : `${label} ×${count} — nothing on the record says what these requests carried, ` +
              'so whether they were one write repeated or different writes could not be established',
        });
      }
    }
  }

  // ── The UI advanced over a request that never came back ─────────────────────────────────────
  // Gated on the UI having moved: an in-flight request while the app is still visibly waiting is
  // just a slow request, not a contradiction. It becomes one when the app proceeded regardless —
  // which is also what makes a later `{ kind: "settled" }` assertion a false green.
  if (true === advanced) {
    const settledIds = new Set(
      events
        .filter((e) => e.type === EventType.NET_REQUEST)
        .map((e) => asString(e.data['id']))
        .filter((id): id is string => id !== undefined),
    );
    const inFlight = events
      .filter((e) => e.type === EventType.NET_PENDING)
      .map((e) => ({ id: asString(e.data['id']), call: netCall(e) }))
      .filter((p) => p.id === undefined || !settledIds.has(p.id));
    if (inFlight.length > 0) {
      found.push({
        kind: ContradictionKind.REQUEST_NEVER_SETTLED,
        claim: 'the UI moved forward and the action reported done',
        counter: `${String(inFlight.length)} request(s) were still in flight`,
        // The exclusion is never silent: if the toolchain's own traffic was dropped from this count,
        // the finding says which URLs, so an agent reading it can see what Reticle chose to ignore.
        detail: [
          inFlight.map((p) => describe(p.call)).join('; '),
          ...(0 === ignoredForeign.length
            ? []
            : [`ignored as dev tooling or third-party: ${ignoredForeign.join(', ')}`]),
        ].join(' — '),
      });
    }
  }

  // Consumer rules run LAST and over the same app-only window, so a service embedding this engine
  // adds to the verdict rather than forking the file that produces it.
  return [...found, ...runRegisteredFolds(events, options)];
}

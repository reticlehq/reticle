import type { Contradiction, ContradictionKind, ReticleEvent } from '@reticlehq/core';
import type { NoteFn } from '../window/engine-host.js';
import type { DeclaredNetFailure } from '../question/declared.js';

/**
 * What a contradiction IS, separated from the rules that find one.
 *
 * A leaf. Five sibling rules name these shapes to declare their own signatures, and all five had to
 * import them back out of `contradictions.ts` — the module that calls them. TypeScript erases those
 * imports, so nothing was ever wrong at runtime; the cycle was real to every tool that reads imports,
 * and it made the hunter look like the source of a vocabulary it only uses.
 */

/**
 * A contradiction emitted by one of THIS package's rules — the kind is closed.
 *
 * Widening `Contradiction.kind` to `string` for the consumer seam would otherwise have made every
 * emit site below accept a typo'd literal. This keeps them checked without closing the edge.
 */
// Re-exported so every existing consumer keeps its import path; the shape itself lives in core.
export type { Contradiction };

export type OwnContradiction = Contradiction & { kind: ContradictionKind };

export interface ContradictionOptions {
  /**
   * Somewhere to record a rule that threw while it ran. See engine-host.ts.
   *
   * Optional: leave it out and the crash is still collected and surfaced by `crashedRuleNotes`, it
   * just is not written down anywhere else.
   */
  note?: NoteFn;
  /** The action that opened this window, when one did. Enables the no-effect check. */
  action?: string | undefined;
  /**
   * Events from BEFORE the window, used only to LEARN — never reported on. Some disagreements are
   * with something the API stated earlier in the session, which an action-scoped window cannot
   * contain. See `findUnitMismatches` for the measured case this exists for.
   */
  prior?: readonly ReticleEvent[] | undefined;
  /**
   * Event time at which the action that opened this window was dispatched — the attribution floor.
   *
   * `duplicate-request` claims "one user action was performed", and that claim is only sound over ONE
   * action's window. `reticle_observe` takes a caller-supplied window that can be arbitrarily wide, so
   * two legitimate separate saves to the same endpoint read as a double submit — and the finding then
   * sat on every verdict for that tab. Undefined means nothing attributed the window to an action, and
   * the rule stays silent rather than accusing an app of something nobody can show it did.
   *
   * ponytail: a NET_REQUEST is stamped when it COMPLETED, so a write dispatched before the action and
   * landing after it counts as inside. Keying on the matching NET_PENDING would fix that; it has not
   * been worth the second index.
   */
  actionSince?: number | undefined;
  /**
   * DOM mutations observed INSIDE the target's own subtree, as the act tool measured them.
   *
   * The no-effect check used to require a completely empty window, which is a statement about the
   * PAGE rather than about the action — and no real app has a quiet page. Measured on a shipments
   * console with a background event stream: clicking an inert heading produced `domMutatedWithin: 0`
   * and four ambient events (a scroll position, an unrelated store update, a perf sample), so the
   * window was not empty and the dead control went unreported. The user's framing of this is exact:
   * the DOM moving after an action is not evidence that the action moved it.
   *
   * Undefined means the caller did not measure it — the check then falls back to the empty-window
   * test, which is weaker but never wrong in the direction of a false accusation.
   */
  mutatedWithin?: number | undefined;
  /**
   * Requests the CALLER declared would fail, read off the oracle it wrote before acting.
   *
   * `ui-advanced-request-failed` cannot tell "the app swallowed the error and carried on" from "the
   * app rendered the error, which is the behaviour under test" — both are a moved DOM beside a
   * failed request. `failureAcknowledged` recovers the first from the app's own state, and an app
   * that renders its error straight into the DOM without touching a store defeats it.
   *
   * The declaration is the missing evidence, and it costs no new API: an agent verifying an error
   * path already writes `{ net, POST, /api/login, status: 500 }` into the predicate. Measured in the
   * field: every branch of a login error path (500, 401, 503) passed every declared clause and every
   * run still returned `verified: "no" / contradicted`, so error handling — empty states, offline
   * banners, 4xx/5xx messaging, lockouts — was the code least able to reach a green verdict and the
   * most worth verifying.
   *
   * Scoped as narrowly as it can be: it suppresses ONLY the heuristic rule that cannot see the
   * difference. A success signal fired over the declared failure still contradicts, and a server
   * fault blamed on the user is still misattributed — see the negative controls in
   * `contradictions.declared.test.ts`.
   */
  expectedFailures?: readonly DeclaredNetFailure[] | undefined;
  /**
   * The caller declared an on-screen consequence and it HELD in this window.
   *
   * `route-rendered-nothing` infers a blank destination from the absence of DOM events, and a
   * verdict that names it beside an element match — heading found, with its source file and line —
   * is a clause its own evidence disproves. Positive evidence outranks the absence it is inferred
   * from. Undefined/false leaves the rule exactly as it was, which is the case that catches a route
   * with no view.
   */
  renderProved?: boolean | undefined;
  /**
   * The document currently under observation, as the session derived it from its own event stream.
   *
   * Every rule below reasons about "the same window", and a window is scoped by time and by
   * ring-buffer capacity and by nothing else — so it can still hold the traffic of a page a full
   * navigation or a reload has already thrown away. Naming that traffic as the cause of an action
   * taken now is true about the bytes and false about the world.
   *
   * Undefined means nobody could say which document is current (an SDK too old to stamp one, a caller
   * with no session in hand), and the scoping then does nothing at all — `isSameDocument` treats
   * absence as current on both sides, so the engine behaves exactly as it did before this existed.
   */
  currentDocumentId?: string | undefined;
  /**
   * The edit epoch currently in force, as the session derived it from its own event stream.
   *
   * The edit-shaped half of `currentDocumentId`. A hot update replaces modules and re-renders inside
   * the SAME document, so the document id cannot see it and observations of code the agent has
   * already rewritten go on answering for it in silence.
   *
   * Undefined means nobody could say (an SDK too old to stamp one, a page with no hot-update channel,
   * a caller with no session in hand) and the scoping then does nothing at all — `isSameEditEpoch`
   * treats absence as current on both sides.
   */
  currentEditEpoch?: number | undefined;
  /**
   * The page under test, as the session last recorded it — the app's own origin, in URL form.
   *
   * The first-party/third-party axis. Every rule below asks "did the app disagree with itself", and
   * a failed analytics beacon is not the app: reported independently from several apps, any
   * analytics package installed was enough to grade a correct drive `contradicted`, and on one app
   * EVERY assertion came back that way forever, because it fires a branding call on page load. A
   * verdict field that answers "no" to everything has stopped being a verdict field.
   *
   * Third-party traffic is dropped here rather than reported at a lower severity, for the reason the
   * dev-tooling split is: the rules below would each have to learn to say it. The exclusion is never
   * silent — the URLs ride out in the same disclosure line the toolchain's do — and the calls
   * themselves are untouched in `reticle_network` and the event timeline.
   *
   * Undefined disables the axis, exactly as an undefined `currentDocumentId` disables the document
   * one: a caller that cannot say which page is under test gets the behaviour it had before this.
   */
  appOrigin?: string | undefined;
  /**
   * The traffic the assertion actually named — `urlContains` from each net clause, `''` for a clause
   * that named the whole channel.
   *
   * Used only by `duplicate-request`, to tell "the write you asked about fired twice" from "some
   * other endpoint is busy". Undefined disables the split and every duplicate is reported as it was
   * before, which is what a caller with no predicate (a bare `observe`) should get: with nothing
   * declared, nothing is unrelated.
   */
  namedNetUrls?: readonly string[] | undefined;
}

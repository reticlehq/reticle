/**
 * What one action reports back: the effect it had, and the anchor that names its target.
 *
 * Split from `actions.ts`, which dispatches; this is the shape of the answer and the one read that
 * has to happen before dispatch (the anchor, while the target is still mounted).
 */
import { readTestId } from '@/dom/addressing/testid-attr.js';
import { QueryBy, type SettleReason } from '@reticlehq/core';
import { elementsMatching } from '@/dom/query.js';
import { getAccessibleName, getRole, isSensitiveField } from '@/dom/a11y.js';
import { identifyComponent } from '@/registry/stores/adapters.js';
import { isReticleUi } from '@/dom/dom-ignore.js';

/**
 * Best-effort evidence of whether/why an action landed, so the agent can separate
 * "my action missed" vs "app didn't react" vs "tool didn't dispatch". All probes are
 * cheap and best-effort (see docs/usage.md).
 */
export interface ActionEffect {
  /** We reached dispatch (no throw before it). Typed `true`: if we never dispatch we throw. */
  dispatched: true;
  /** Ref resolved to a still-connected element at read time. */
  targetMatched: boolean;
  /** visibility isVisible(el) at the start of the action. */
  visible: boolean;
  /** Not disabled / aria-disabled at the start of the action. */
  enabled: boolean;
  /** The primary cancelable event's dispatchEvent returned false (handler called preventDefault). */
  defaultPrevented: boolean;
  /** "<prevRef>-><newRef>" if document.activeElement changed, else null. body counts as null. */
  focusMoved: string | null;
  /** fill/type/clear only: input value before !== after; else false. */
  valueChanged: boolean;
  /** A password fill in WebKit, made without focus so no saved-password panel rose. */
  autofillSafe?: true;
  /** Mutation records counted by a short-lived MutationObserver (one microtask + rAF window). */
  domMutatedWithin: number;
  /**
   * Text the action put on the page, truncated. OMITTED when it added none.
   *
   * `domMutatedWithin` says the click did SOMETHING; it cannot say the app rejected you. A login
   * that fails returns ok/settled/mutated and reads exactly like one that succeeded, so an agent
   * moves on and asserts against a page it misread. The observer already receives these records
   * and was keeping only `.length` — the message was being thrown away, not gathered.
   *
   * Deliberately NOT a verdict: this is what appeared, not what it means. Absence means no text
   * was added, which is why a silent class toggle omits the key rather than reporting "".
   */
  appeared?: string;
  /**
   * Click-like only: the center hit-tested to a foreign element (an overlay is on top). Synthetic
   * dispatch STILL delivered the event to the target, but a real user could not click it — treat
   * the target as visually blocked. `false` when not click-like or not hit-testable (no layout).
   */
  occluded: boolean;
  /** Ref of the element actually on top at the click point when `occluded`, else null. */
  occludedBy: string | null;
  /** Click-like only: the target was off-viewport, so it was scrolled into view before dispatch. */
  scrolledIntoView: boolean;
  /** When `occluded`: what covers the target, in words (test id, else role and name, else tag). */
  occluderName?: string;
  /** Click-like only: the target is laid out with no size, so a person has nothing to click. */
  noSize?: true;
  /** Click-like only: still outside the viewport after it was scrolled into view. */
  offViewport?: true;
  /**
   * How long the pointer was ACTUALLY held down, for a click with `args.holdMs`. Absent otherwise.
   *
   * Measured, not echoed. `holdMs: 1200` against a 1200ms animation is a race by construction, so a
   * caller needs to tell "held 1200" from "held 1204" — and a backgrounded tab throttles timers, so
   * the achieved hold can legitimately be much longer than the one requested.
   */
  heldMs?: number;
  /**
   * check/uncheck only: the control ALREADY read as the requested state, so NOTHING was dispatched.
   * OMITTED otherwise (the uninformative default).
   *
   * Not clicking is right — clicking an already-checked box would uncheck it. But the branch that
   * skips the click reads the DOM PROPERTY, and that is not evidence about what the APPLICATION
   * holds. They come apart exactly when it matters: a default-checked input the app has not
   * committed, a property written earlier by something else, a control read mid-render. Then `check`
   * no-ops, the framework never hears, and every later read agrees because every later read is also
   * reading the DOM: a form's flag stays unset in the database while Reticle confirms it checked.
   *
   * So this is a caveat, not a failure: the requested state is what the DOM shows, and Reticle did
   * not put it there. Assert the app's own state (a signal, a request, a derived control) rather than
   * the box.
   */
  alreadyAtValue?: true;
  /**
   * How many `<canvas>` elements were on screen when the action settled. OMITTED when none.
   *
   * A canvas draws its output as pixels, and no channel here reads pixels. The daemon uses this to
   * say so for the run (`pixels-unobserved`) rather than let a quiet DOM read as a correct drawing.
   */
  canvases?: number;
}

const CANVAS_SELECTOR = 'canvas';

/** Canvases with a size, inside the viewport, that are the app's own (not Reticle's UI). */
export function visibleCanvases(doc: Document): number {
  const width = doc.defaultView?.innerWidth ?? 0;
  const height = doc.defaultView?.innerHeight ?? 0;
  let count = 0;
  for (const canvas of doc.querySelectorAll(CANVAS_SELECTOR)) {
    if (isReticleUi(canvas)) {
      continue;
    }
    const box = canvas.getBoundingClientRect();
    const sized = box.width > 0 && box.height > 0;
    const onScreen = box.bottom > 0 && box.right > 0 && box.top < height && box.left < width;
    if (sized && onScreen) {
      count += 1;
    }
  }
  return count;
}

export interface ActionResult {
  ok: true;
  ref: string;
  action: string;
  /** We reached dispatch without throwing. Mirror of effect.dispatched for top-level reads. */
  dispatched: boolean;
  /** A real animation frame fired within the settle budget (false = fallback timer fired). */
  settled: boolean;
  /** Why settle did not complete on a real frame: SettleReason.TIMEOUT when the budget fallback fired, else null. */
  settleReason: SettleReason | null;
  effect: ActionEffect;
  /** data-testid of the resolved element, when present — lets the server compile a ref-stable replay step. */
  testid?: string;
  /** How many elements carry that test id, when more than one does: then it is no anchor. */
  testidOf?: number;
  /**
   * Auto-anchor fallback (attached ONLY when there is no testid): the element's nearest component
   * name + source location, so the server can compile a stable `component` anchor instead of a
   * degraded role one — addressing the element across replays with zero hand-added testids.
   */
  component?: string;
  /** Role + accessible name — the anchor that identifies an INSTANCE, not a JSX site. */
  role?: string;
  name?: string;
  /** Which of several controls sharing that role and name this was, and how many there were. */
  nth?: number;
  of?: number;
  source?: { file: string; line: number; column?: number };
  /**
   * The target holds a secret (a password input, a credential autocomplete, a sensitive name). The
   * server redacts a recorded fill by this, so a field labelled in any language is never saved in clear.
   */
  secret?: true;
  /** Best-effort caveat the agent should heed (e.g. synthetic hover may not fire enter/leave). */
  warning?: string;
  /** The target is Reticle's own UI (reachable only with the HUD exposed): never an app step. */
  reticleUi?: true;
}

/** The element's stable anchor: testid (gold), else component/source (auto-anchor). */
export interface CapturedAnchor {
  testid?: string;
  testidOf?: number;
  component?: string;
  source?: { file: string; line: number; column?: number };
  /**
   * Role + accessible name — the anchor that identifies an INSTANCE.
   *
   * A component/source anchor names the JSX site, and one `<input>` written inside a row renders
   * once per row: measured on a shipments console, three different rows' checkboxes compiled to the
   * identical anchor and a replay resolved all three to the same element (91 matches, first taken).
   * The accessible name does not collapse that way — "select ATL-100000" is one row and no other —
   * and it is the only stable anchor an app with no testids has at all.
   */
  role?: string;
  name?: string;
  nth?: number;
  of?: number;
  /** See ActionResult.secret. */
  secret?: true;
}

/**
 * Capture an element's anchor BEFORE the action runs. Critical: a navigating/destructive action can
 * unmount the target (login submit, a close button), after which it has no readable attribute — so
 * reading the anchor post-settle would silently degrade the recorded step. We read it up front while
 * the element is still mounted.
 *
 * The component walk runs even when a testid is present. A testid is the better ANCHOR, but skipping
 * the walk also throws away the source pointer, which answers a different question — where is this
 * defined? — and is the most useful thing to hand an agent that has to fix what it just broke. Acts
 * are agent-initiated and rare, so the walk's cost is not on any hot path.
 */
export function anchorOf(el: Element): CapturedAnchor {
  const testid = readTestId(el) ?? undefined;
  const info = identifyComponent(el);
  const out: CapturedAnchor = {};
  if (testid !== undefined) {
    out.testid = testid;
    // A replay takes the first match, so a shared test id would land on another element.
    const shared = elementsMatching({ by: QueryBy.TESTID, value: testid }).length;
    if (1 < shared) {
      out.testidOf = shared;
    }
  }
  const component = info?.componentStack[0];
  if (component !== undefined) {
    out.component = component;
  }
  if (info?.source !== undefined) {
    out.source = info.source;
  }
  // Reported INDEPENDENTLY, never all-or-nothing: otherwise an element with a role and no accessible
  // name — an icon button, a clickable div, a control labelled by an SVG — comes back with no identity
  // at all once identifyComponent (React-specific) also finds nothing. Two features silently degrade
  // without it: the flow recorder anchors a step by it, and coverage recognises a control it already
  // drove across a re-render by it.
  //
  // A role alone is not a unique anchor, and the flow compiler still requires role AND name before it
  // will anchor a step that way. But it is real information, and reporting it beats reporting nothing.
  const role = getRole(el);
  const name = getAccessibleName(el);
  if (role.length > 0) {
    out.role = role;
  }
  if (name.length > 0) {
    out.name = name;
  }
  if (isSensitiveField(el)) {
    out.secret = true;
  }
  if (role.length > 0 && name.length > 0) {
    // A sidebar link and a card link both named "Transactions": without the position, the recorded
    // step was ambiguous on every replay.
    const same = elementsMatching({ by: QueryBy.ROLE, value: role, name });
    const at = same.indexOf(el as HTMLElement);
    if (1 < same.length && 0 <= at) {
      out.nth = at;
      out.of = same.length;
    }
  }
  return out;
}

export const result = (
  ref: string,
  action: string,
  effect: ActionEffect,
  settled: boolean,
  settleReason: SettleReason | null,
  anchor: CapturedAnchor,
  warning?: string,
): ActionResult => {
  const base: ActionResult = {
    ok: true as const,
    ref,
    action,
    dispatched: true,
    settled,
    settleReason,
    effect,
  };
  // Anchor and provenance are reported side by side rather than as alternatives: the testid says how
  // to find this element next run, the component/source says where it is written. A step is anchored
  // by the testid when it has one (see the flow compiler) and that is unchanged — what changed is
  // that having a testid no longer erases the answer to "which file do I open?".
  if (anchor.testid !== undefined) {
    base.testid = anchor.testid;
  }
  if (anchor.testidOf !== undefined) {
    base.testidOf = anchor.testidOf;
  }
  if (anchor.component !== undefined) {
    base.component = anchor.component;
  }
  if (anchor.source !== undefined) {
    base.source = anchor.source;
  }
  if (anchor.role !== undefined) {
    base.role = anchor.role;
  }
  if (anchor.name !== undefined) {
    base.name = anchor.name;
  }
  if (anchor.nth !== undefined) {
    base.nth = anchor.nth;
  }
  if (anchor.of !== undefined) {
    base.of = anchor.of;
  }
  if (anchor.secret !== undefined) {
    base.secret = anchor.secret;
  }
  if (warning !== undefined) {
    base.warning = warning;
  }
  return base;
};

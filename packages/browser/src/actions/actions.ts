import {
  ActionType,
  ActionWarning,
  DANGEROUS_ACTION_CONFIRM_ARG,
  ElementState,
  isDangerousActionText,
  SettleReason,
} from '@reticlehq/core';
import { echoRef, refs } from '../dom/refs.js';
import { assertEditable, assertNotRichText, setNativeValue } from './value-input.js';
import { getAccessibleName, getRole, isVisible, getStates } from '../dom/a11y.js';
import { elementHasHoverHandlers, identifyComponent } from '../registry/adapters.js';
import { isForm, isHtmlElement, isInput, isSelect, isTextArea } from '../dom/realm.js';
import { nativeSetTimeout, settle } from '../timers/native-timers.js';
import { AppearedText } from './appeared-text.js';

/**
 * Best-effort evidence of whether/why an action landed, so the agent can separate
 * "my action missed" vs "app didn't react" vs "tool didn't dispatch". All probes are
 * cheap and best-effort (see docs/usage.md).
 */
interface ActionEffect {
  /** We reached dispatch (no throw before it). Typed `true`: if we never dispatch we throw. */
  dispatched: true;
  /** Ref resolved to a still-connected element at read time. */
  targetMatched: boolean;
  /** a11y isVisible(el) at the start of the action. */
  visible: boolean;
  /** Not disabled / aria-disabled at the start of the action. */
  enabled: boolean;
  /** The primary cancelable event's dispatchEvent returned false (handler called preventDefault). */
  defaultPrevented: boolean;
  /** "<prevRef>-><newRef>" if document.activeElement changed, else null. body counts as null. */
  focusMoved: string | null;
  /** fill/type/clear only: input value before !== after; else false. */
  valueChanged: boolean;
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
  /**
   * How long the pointer was ACTUALLY held down, for a click with `args.holdMs`. Absent otherwise.
   *
   * Measured, not echoed. `holdMs: 1200` against a 1200ms animation is a race by construction, so a
   * caller needs to tell "held 1200" from "held 1204" — and a backgrounded tab throttles timers, so
   * the achieved hold can legitimately be much longer than the one requested.
   */
  heldMs?: number;
}

interface ActionResult {
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
  /**
   * Auto-anchor fallback (attached ONLY when there is no testid): the element's nearest component
   * name + source location, so the server can compile a stable `component` anchor instead of a
   * degraded role one — addressing the element across replays with zero hand-added testids.
   */
  component?: string;
  /** Role + accessible name — the anchor that identifies an INSTANCE, not a JSX site. */
  role?: string;
  name?: string;
  source?: { file: string; line: number; column?: number };
  /** Best-effort caveat the agent should heed (e.g. synthetic hover may not fire enter/leave). */
  warning?: string;
}

function asString(value: unknown, fallback = ''): string {
  return 'string' === typeof value ? value : fallback;
}

function requireElement(ref: string): HTMLElement {
  const el = refs.resolve(ref);
  if (null === el) throw new Error(`ref '${echoRef(ref)}' no longer resolves to an element`);
  if (!isHtmlElement(el)) throw new Error(`ref '${echoRef(ref)}' is not an HTMLElement`);
  return el;
}

/** The element's stable anchor: testid (gold), else component/source (auto-anchor). */
interface CapturedAnchor {
  testid?: string;
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
}

/**
 * Capture an element's anchor BEFORE the action runs. Critical: a navigating/destructive action can
 * unmount the target (login submit, a close button), after which it has no readable attribute — so
 * reading the anchor post-settle would silently degrade the recorded step. We read it up front while
 * the element is still mounted.
 *
 * The component walk runs even when a testid is present. It used to be skipped, on the reasoning that
 * a testid is the better anchor and the walk is wasted work — true for anchoring, but it also threw
 * away the source pointer, which answers a different question (where is this defined?) and is the
 * most useful thing we can give an agent that has to fix the thing we just broke. Acts are
 * agent-initiated and rare, so the walk's cost is not on any hot path.
 */
function anchorOf(el: Element): CapturedAnchor {
  const testid = el.getAttribute('data-testid') ?? undefined;
  const info = identifyComponent(el);
  const out: CapturedAnchor = {};
  if (testid !== undefined) out.testid = testid;
  const component = info?.componentStack[0];
  if (component !== undefined) out.component = component;
  if (info?.source !== undefined) out.source = info.source;
  // Reported INDEPENDENTLY. They used to be all-or-nothing, so an element with a role and no
  // accessible name — an icon button, a clickable div, a control labelled by an SVG — came back with
  // no identity at all once identifyComponent (React-specific) also found nothing. Two features read
  // this and both silently degrade without it: the flow recorder anchors a step by it, and coverage
  // recognises a control it already drove across a re-render by it.
  //
  // A role alone is not a unique anchor, and the flow compiler still requires role AND name before it
  // will anchor a step that way. But it is real information, and reporting it beats reporting nothing.
  const role = getRole(el);
  const name = getAccessibleName(el);
  if (role.length > 0) out.role = role;
  if (name.length > 0) out.name = name;
  return out;
}

const result = (
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
  if (anchor.testid !== undefined) base.testid = anchor.testid;
  if (anchor.component !== undefined) base.component = anchor.component;
  if (anchor.source !== undefined) base.source = anchor.source;
  if (anchor.role !== undefined) base.role = anchor.role;
  if (anchor.name !== undefined) base.name = anchor.name;
  if (warning !== undefined) base.warning = warning;
  return base;
};

// SELECT is fill-like for the purpose of `valueChanged`: selecting a value with NO matching <option>
// leaves el.value unchanged (or ''), and valueChanged:false is the only signal an agent gets that the
// select silently did nothing. Without it a no-op SELECT reported plain success — a false green.
const FILL_LIKE = new Set<string>([
  ActionType.FILL,
  ActionType.TYPE,
  ActionType.CLEAR,
  ActionType.SELECT,
]);
const isFillLike = (action: string): boolean => FILL_LIKE.has(action);

/** Actions that resolve to a point and so benefit from off-viewport scroll + occlusion hit-test. */
const CLICK_LIKE = new Set<string>([ActionType.CLICK, ActionType.DBLCLICK]);

function dangerousActionContext(el: HTMLElement): string {
  const form = el.closest('form');
  return [
    getAccessibleName(el),
    el.textContent ?? '',
    el.getAttribute('value') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('href') ?? '',
    form?.getAttribute('action') ?? '',
    form?.textContent ?? '',
  ].join(' ');
}

function requiresDangerousConfirmation(text: string): boolean {
  return isDangerousActionText(text);
}

function assertActionAllowed(el: HTMLElement, action: string, args: Record<string, unknown>): void {
  const canTrigger =
    action === ActionType.CLICK ||
    action === ActionType.DBLCLICK ||
    action === ActionType.DRAG ||
    action === ActionType.SUBMIT ||
    (action === ActionType.PRESS && 'Enter' === asString(args['key'], 'Enter'));
  const dragTarget = action === ActionType.DRAG ? refs.resolve(asString(args['toRef'])) : null;
  const context = isHtmlElement(dragTarget)
    ? `${dangerousActionContext(el)} ${dangerousActionContext(dragTarget)}`
    : dangerousActionContext(el);
  if (
    canTrigger &&
    requiresDangerousConfirmation(context) &&
    args[DANGEROUS_ACTION_CONFIRM_ARG] !== true
  ) {
    throw new Error(
      `potentially destructive action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
    );
  }
}

/** Best-effort click-point geometry. All-false default when there is nothing measurable to test. */
import {
  NO_GEOMETRY,
  fireClickSequence,
  clickGeometry,
  firePointer,
  firePointerNonBubbling,
  dragElement,
} from './actions-dom.js';

/** Derive `enabled` from the shared a11y state logic (disabled prop + aria-disabled). */
function enabledOf(el: Element): boolean {
  return !getStates(el).includes(ElementState.DISABLED);
}

/** Current value for inputs/textareas/selects, else undefined. */
function valueOf(el: Element): string | undefined {
  if (isInput(el) || isTextArea(el) || isSelect(el)) {
    return el.value;
  }
  return undefined;
}

/** Ref of the currently-focused element, treating body/null as "no focus". */
function activeRef(el: Element): string | null {
  const active = el.ownerDocument.activeElement;
  if (null === active || active === el.ownerDocument.body) return null;
  return refs.refFor(active);
}

/**
 * Dispatch the action's events. Returns `defaultPrevented` of the primary cancelable event
 * (false for actions whose primary event is non-cancelable or unobservable). Drag/hover-hold
 * await internally; the probe wrapper builds the result once they resolve.
 */
/**
 * The longest a single action may hold the pointer down, in milliseconds.
 *
 * An unbounded `holdMs` is a tool call that never returns, which is the failure the transport layer
 * is shaped around. 30s is far above any real hold-to-confirm (the reported case was 1.2s) and far
 * below a hang.
 */
export const MAX_HOLD_MS = 30_000;

/** A hold the caller asked for, bounded and sanitised. Non-numbers and negatives mean "no hold". */
function clampHold(raw: unknown): number {
  if ('number' !== typeof raw || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_HOLD_MS);
}

/**
 * The outcome of dispatching one action: whether the primary event was prevented, and — for a hold —
 * how long the pointer was actually down.
 *
 * `heldMs` is returned rather than stashed on a module-level variable: several actions can be in
 * flight at once, and a shared "last hold" would attribute one action's duration to another. That is
 * the same mistake the tool-call timing pair upstream already avoids.
 */
interface DispatchOutcome {
  prevented: boolean;
  heldMs: number;
}

/**
 * Click is the only action that can hold the pointer down, so it is the only one that reports a
 * duration. Everything else routes through the switch below unchanged and holds for zero.
 */
async function dispatchFor(
  el: HTMLElement,
  action: string,
  args: Record<string, unknown>,
): Promise<DispatchOutcome> {
  if (ActionType.CLICK === action) {
    // Full pointer/mouse sequence (not a bare click) so pointer- and focus-gated handlers fire the
    // way they do for a real user.
    //
    // `args.holdMs` keeps the pointer down in between, which is the only way to drive a
    // hold-to-confirm control. Capped: an unbounded hold is a tool call that never returns.
    const hold = clampHold(args['holdMs']);
    return await fireClickSequence(
      el,
      0 === hold ? undefined : { ms: hold, sleep, now: () => Date.now() },
    );
  }
  return { prevented: await dispatchOther(el, action, args), heldMs: 0 };
}

async function dispatchOther(
  el: HTMLElement,
  action: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  switch (action) {
    case ActionType.DBLCLICK:
      return !el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    case ActionType.HOVER: {
      const doc = el.ownerDocument;
      // Best-effort "previous" node for relatedTarget so React's enter/leave synthesis has a "from".
      const from: EventTarget = doc.activeElement ?? doc.body;
      // Bubbling over/move with relatedTarget so React's delegated root can synthesize enter/leave.
      firePointer(el, 'pointerover', from);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
      // Non-bubbling enter pair (per spec) for direct enter/onMouseEnter listeners.
      firePointerNonBubbling(el, 'pointerenter', from);
      el.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: from }));
      firePointer(el, 'pointermove', from);
      const moved = el.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, cancelable: true }),
      );
      // hover-dwell: keep "hovering" for holdMs so timer-gated reveals can mount. Same cap as
      // click — this arg was previously unbounded here, which is the same never-returns hazard.
      const holdMs = clampHold(args['holdMs']);
      if (holdMs > 0) await sleep(holdMs);
      return !moved;
    }
    case ActionType.FOCUS:
      el.focus();
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return false; // FocusEvents are not cancelable.
    case ActionType.BLUR:
      // Fire a bubbling focusout so React 19's delegated root listener runs onBlur
      // (commit-on-blur). el.blur alone only works if the element was truly focused.
      el.blur();
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return false;
    case ActionType.FILL:
      if (isInput(el) || isTextArea(el)) {
        // A MISSING value is a malformed call, not a request to empty the field. `asString` defaults
        // to '', which made such a fill indistinguishable from `clear`: it wiped what was there,
        // dispatched a real input event so React committed the empty string to state, and reported
        // ok:true with nothing flagged. The value is nested (`args:{value}`) at the tool boundary, so
        // passing it at the top level lands here — measured on bench-app's login form, where
        // "admin@reticle.dev" was destroyed by a fill that reported success. An explicit '' still
        // clears, because that is someone asking for it.
        if (typeof args['value'] !== 'string') {
          throw new Error(
            "fill requires a string `value` — pass it nested, as args: { value: '…' }. " +
              'To empty a field on purpose use the `clear` action, or fill with an explicit "".',
          );
        }
        assertEditable(el, 'fill');
        el.focus(); // focus first so a later blur commits (onBlur editors)
        return setNativeValue(el, args['value']);
      }
      assertNotRichText(el, 'fill');
      throw new Error(`cannot fill a <${el.tagName.toLowerCase()}>`);
    case ActionType.TYPE:
      if (isInput(el) || isTextArea(el)) {
        // Same family as the valueless FILL: a missing `text` appended '' and reported ok:true, so an
        // agent believed it had typed into a field nothing was written to.
        if (typeof args['text'] !== 'string') {
          throw new Error(
            "type requires a string `text` — pass it nested, as args: { text: '…' }.",
          );
        }
        assertEditable(el, 'type');
        el.focus();
        return setNativeValue(el, el.value + args['text']);
      }
      assertNotRichText(el, 'type into');
      throw new Error(`cannot type into a <${el.tagName.toLowerCase()}>`);
    case ActionType.CLEAR:
      if (isInput(el) || isTextArea(el)) {
        return setNativeValue(el, '');
      }
      // Consistent with TYPE/SELECT/CHECK: clearing a non-field is not a silent success. Throwing
      // surfaces the mismatch instead of reporting ok:true for an action that did nothing.
      throw new Error(`cannot clear a <${el.tagName.toLowerCase()}>`);
    case ActionType.SELECT:
      if (isSelect(el)) {
        // A MISSING value assigned '' to the <select>. No option carries that, so the browser sets
        // selectedIndex to -1 — deselecting everything — from a call that was simply malformed.
        if (typeof args['value'] !== 'string') {
          throw new Error(
            "select requires a string `value` — pass it nested, as args: { value: '…' }.",
          );
        }
        const wanted = args['value'];
        const options = Array.from(el.options);
        // REFUSE an option that does not exist, before touching the element.
        //
        // This used to assign anyway and report the resulting `valueChanged` delta as proof the
        // option never took. That only works if nobody is listening. An unmatched value drives
        // selectedIndex to -1, so `el.value` becomes '' — and we then dispatched `change`. Reported
        // from a real session: the app read that empty value in its change handler and persisted it,
        // corrupting a stored language setting. The "detectable no-op" both mutated the app into a
        // state no user could reach AND did it through the app's own handler.
        //
        // Same rule as the readonly/disabled refusal: if a real user could not do it, forcing it is
        // not a test, it is damage.
        if (!options.some((option) => option.value === wanted)) {
          const available = options.map((option) => `${option.value} (${option.label})`).join(', ');
          throw new Error(
            `no <option> with value '${echoRef(wanted)}' — available: ${0 === options.length ? '(none)' : available}`,
          );
        }
        el.value = wanted;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false; // change is not cancelable.
      }
      throw new Error(`cannot select on a <${el.tagName.toLowerCase()}>`);
    case ActionType.CHECK:
    case ActionType.UNCHECK:
      if (isInput(el)) {
        el.checked = action === ActionType.CHECK;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
      }
      throw new Error(`cannot (un)check a <${el.tagName.toLowerCase()}>`);
    case ActionType.SUBMIT: {
      const form = isForm(el) ? el : el.closest('form');
      if (null === form) throw new Error('no form to submit');
      form.requestSubmit();
      return false; // requestSubmit returns void; the internal submit event is unobservable.
    }
    case ActionType.PRESS: {
      const key = asString(args['key'], 'Enter');
      const down = el.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      return !down;
    }
    case ActionType.SCROLL_INTO_VIEW:
      el.scrollIntoView();
      return false;
    case ActionType.UPLOAD: {
      if (!isInput(el) || el.type !== 'file') {
        throw new Error('upload target must be a <input type="file">');
      }
      const file = new File(
        [asString(args['content'], 'reticle test file')],
        asString(args['name'], 'file.txt'),
        {
          type: asString(args['type'], 'text/plain'),
        },
      );
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      const inputOk = el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return !inputOk;
    }
    case ActionType.DRAG: {
      const toRef = asString(args['toRef']);
      // asString falls back to '' (never undefined), so the old `!== undefined` was always true and
      // handed '' to refs.resolve. A drag with no target ref is a free drag — resolve nothing.
      const resolved = toRef !== '' ? refs.resolve(toRef) : null;
      return await dragElement(el, isHtmlElement(resolved) ? resolved : null, args['data']);
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

/**
 * Execute a single action against a ref and probe for best-effort evidence of effect.
 * Always async: the MutationObserver read needs a microtask + rAF after dispatch.
 */
export async function executeAction(
  ref: string,
  action: string,
  args: Record<string, unknown> = {},
): Promise<ActionResult> {
  const el = requireElement(ref);
  assertActionAllowed(el, action, args);
  // Capture the anchor while the element is still mounted — the action may unmount it (navigation).
  const anchor = anchorOf(el);
  const visible = isVisible(el);
  const enabled = enabledOf(el);
  const prevFocus = activeRef(el);
  const valueBefore = valueOf(el);
  // Click-like: scroll an off-viewport target in + hit-test the click point BEFORE installing the
  // mutation observer (scroll/hit-test never mutate the DOM, but keep the probe window clean).
  const geometry = CLICK_LIKE.has(action) ? clickGeometry(el) : NO_GEOMETRY;

  let mutated = 0;
  const said = new AppearedText();
  const obs = new MutationObserver((records) => {
    mutated += records.length;
    said.collect(records);
  });
  obs.observe(el.ownerDocument.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  let defaultPrevented = false;
  /** How long the pointer was actually held down. Zero for every action that cannot hold. */
  let heldMs = 0;
  let settled = false;
  let settleReason: SettleReason | null = null;
  try {
    const outcome = await dispatchFor(el, action, args);
    defaultPrevented = outcome.prevented;
    heldMs = outcome.heldMs;
  } finally {
    // bounded settle — microtask + one BOUNDED frame so React's commit (and the resulting DOM
    // mutations → dom.added/dom.text/dom.attr events) flush before we return, landing inside
    // observe({ since }). Bounded so a throttled/background tab never hangs; a settle timeout NEVER
    // rejects (only a real dispatch failure thrown above does). settle can never throw.
    const outcome = await settle();
    settled = outcome.settled;
    settleReason = outcome.settled ? null : SettleReason.TIMEOUT;
    obs.disconnect();
  }

  const valueAfter = valueOf(el);
  const nextFocus = activeRef(el);
  const effect: ActionEffect = {
    dispatched: true,
    targetMatched: el.isConnected,
    visible,
    enabled,
    defaultPrevented,
    focusMoved: prevFocus !== nextFocus ? `${prevFocus ?? 'null'}->${nextFocus ?? 'null'}` : null,
    valueChanged: isFillLike(action) ? valueBefore !== valueAfter : false,
    domMutatedWithin: mutated,
    // Omitted rather than "" when nothing was said — an empty string reads as "it said nothing
    // meaningful", where absence says "it added no text at all". Those are different findings.
    ...said.effect(),
    occluded: geometry.occluded,
    occludedBy: geometry.occludedBy,
    scrolledIntoView: geometry.scrolledIntoView,
    // Omitted when there was no hold: an absent key says "this action does not hold", where a 0
    // would read as "it held for no time", which is a different and misleading claim.
    ...(heldMs > 0 ? { heldMs } : {}),
  };
  // Honesty caveats: a visually-occluded click is reported even though synthetic dispatch landed;
  // else synthetic hover may not fire framework enter/leave handlers (no native hit-test).
  const warning = geometry.occluded
    ? ActionWarning.CLICK_OCCLUDED
    : action === ActionType.HOVER && elementHasHoverHandlers(el)
      ? ActionWarning.HOVER_NATIVE_ENTER_LEAVE
      : undefined;
  return result(ref, action, effect, settled, settleReason, anchor, warning);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => nativeSetTimeout(r, ms));

/** Best-effort WebMCP passthrough: call a navigator.modelContext tool if the site exposes one. */
export async function dispatchWebMcp(
  tool: string,
  params: Record<string, unknown>,
  confirmDangerous = false,
): Promise<unknown> {
  if (requiresDangerousConfirmation(tool) && !confirmDangerous) {
    throw new Error(
      `potentially destructive WebMCP tool blocked; retry with ${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
    );
  }
  const mc = (
    navigator as unknown as { modelContext?: { callTool?: (n: string, p: unknown) => unknown } }
  ).modelContext;
  if (mc === undefined || typeof mc.callTool !== 'function') {
    throw new Error('WebMCP (navigator.modelContext) not available on this page');
  }
  return await mc.callTool(tool, params);
}

export interface ActionStep {
  ref: string;
  action: string;
  args?: Record<string, unknown>;
}

interface SequenceStepResult {
  ref: string;
  action: string;
  /** per-step dispatch/settle outcome (see ActionResult). */
  dispatched: boolean;
  settled: boolean;
  settleReason: SettleReason | null;
  /**
   * The SAME anchors a single act reports. Reporting only the testid meant a testid-less app
   * compiled every sub-step to a volatile ref, so the saved flow carried the degraded sentinel and
   * every replay drifted.
   */
  testid?: string;
  component?: string;
  role?: string;
  name?: string;
  source?: { file: string; line: number; column?: number };
  /** best-effort caveat for this step (e.g. synthetic hover may not fire enter/leave). */
  warning?: string;
}

export async function executeSequence(steps: ActionStep[]): Promise<{
  ok: true;
  count: number;
  effects: ActionEffect[];
  steps: SequenceStepResult[];
}> {
  const effects: ActionEffect[] = [];
  const stepResults: SequenceStepResult[] = [];
  for (const step of steps) {
    const res = await executeAction(step.ref, step.action, step.args ?? {});
    effects.push(res.effect);
    const stepBase: SequenceStepResult = {
      ref: res.ref,
      action: res.action,
      dispatched: res.dispatched,
      settled: res.settled,
      settleReason: res.settleReason,
    };
    if (res.testid !== undefined) stepBase.testid = res.testid;
    if (res.component !== undefined) stepBase.component = res.component;
    if (res.role !== undefined) stepBase.role = res.role;
    if (res.name !== undefined) stepBase.name = res.name;
    if (res.source !== undefined) stepBase.source = res.source;
    if (res.warning !== undefined) stepBase.warning = res.warning;
    stepResults.push(stepBase);
  }
  return { ok: true, count: steps.length, effects, steps: stepResults };
}

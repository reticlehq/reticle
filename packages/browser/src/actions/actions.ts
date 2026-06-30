import {
  ActionType,
  ActionWarning,
  DANGEROUS_ACTION_CONFIRM_ARG,
  ElementState,
  isDangerousActionText,
  SettleReason,
} from '@reticlehq/protocol';
import { refs } from '../dom/refs.js';
import { getAccessibleName, isVisible, getStates } from '../dom/a11y.js';
import { elementHasHoverHandlers, identifyComponent } from '../registry/adapters.js';
import { nativeSetTimeout, settle } from '../timers/native-timers.js';

/**
 * Best-effort evidence of whether/why an action landed, so the agent can separate
 * "my action missed" vs "app didn't react" vs "tool didn't dispatch". All probes are
 * cheap and best-effort (see docs/usage.md §3).
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
   * Click-like only: the center hit-tested to a foreign element (an overlay is on top). Synthetic
   * dispatch STILL delivered the event to the target, but a real user could not click it — treat
   * the target as visually blocked. `false` when not click-like or not hit-testable (no layout).
   */
  occluded: boolean;
  /** Ref of the element actually on top at the click point when `occluded`, else null. */
  occludedBy: string | null;
  /** Click-like only: the target was off-viewport, so it was scrolled into view before dispatch. */
  scrolledIntoView: boolean;
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
  source?: { file: string; line: number; column?: number };
  /** Best-effort caveat the agent should heed (e.g. synthetic hover may not fire enter/leave). */
  warning?: string;
}

/**
 * Set a value on a controlled input the way React expects (native setter + input event).
 * Returns the `input` event's dispatchEvent result (defaultPrevented of the primary event).
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- setter is invoked via .call(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  const notPrevented = el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return !notPrevented;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function requireElement(ref: string): HTMLElement {
  const el = refs.resolve(ref);
  if (el === null) throw new Error(`ref '${ref}' no longer resolves to an element`);
  if (!(el instanceof HTMLElement)) throw new Error(`ref '${ref}' is not an HTMLElement`);
  return el;
}

/** The element's stable anchor: testid (gold), else component/source (auto-anchor). */
interface CapturedAnchor {
  testid?: string;
  component?: string;
  source?: { file: string; line: number; column?: number };
}

/**
 * Capture an element's anchor BEFORE the action runs. Critical: a navigating/destructive action can
 * unmount the target (login submit, a close button), after which it has no readable attribute — so
 * reading the anchor post-settle would silently degrade the recorded step. We read it up front while
 * the element is still mounted.
 */
function anchorOf(el: Element): CapturedAnchor {
  const testid = el.getAttribute('data-testid') ?? undefined;
  if (testid !== undefined) return { testid };
  const info = identifyComponent(el);
  const out: CapturedAnchor = {};
  const component = info?.componentStack[0];
  if (component !== undefined) out.component = component;
  if (info?.source !== undefined) out.source = info.source;
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
  if (anchor.testid !== undefined) {
    base.testid = anchor.testid;
  } else {
    // No testid — carry the auto-anchor so the recorded step stays stable, not degraded.
    if (anchor.component !== undefined) base.component = anchor.component;
    if (anchor.source !== undefined) base.source = anchor.source;
  }
  if (warning !== undefined) base.warning = warning;
  return base;
};

const FILL_LIKE = new Set<string>([ActionType.FILL, ActionType.TYPE, ActionType.CLEAR]);
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
    (action === ActionType.PRESS && asString(args['key'], 'Enter') === 'Enter');
  const dragTarget = action === ActionType.DRAG ? refs.resolve(asString(args['toRef'])) : null;
  const context =
    dragTarget instanceof HTMLElement
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
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  return undefined;
}

/** Ref of the currently-focused element, treating body/null as "no focus". */
function activeRef(el: Element): string | null {
  const active = el.ownerDocument.activeElement;
  if (active === null || active === el.ownerDocument.body) return null;
  return refs.refFor(active);
}

/**
 * Dispatch the action's events. Returns `defaultPrevented` of the primary cancelable event
 * (false for actions whose primary event is non-cancelable or unobservable). Drag/hover-hold
 * await internally; the probe wrapper builds the result once they resolve.
 */
async function dispatchFor(
  el: HTMLElement,
  action: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  switch (action) {
    case ActionType.CLICK:
      // Full pointer/mouse sequence (not a bare click) so pointer- and focus-gated handlers fire
      // the way they do for a real user. Returns the click event's defaultPrevented.
      return fireClickSequence(el);
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
      // hover-dwell: keep "hovering" for holdMs so timer-gated reveals can mount.
      const holdMs = typeof args['holdMs'] === 'number' ? args['holdMs'] : 0;
      if (holdMs > 0) await sleep(holdMs);
      return !moved;
    }
    case ActionType.FOCUS:
      el.focus();
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return false; // FocusEvents are not cancelable.
    case ActionType.BLUR:
      // Fire a bubbling focusout so React 19's delegated root listener runs onBlur
      // (commit-on-blur). el.blur() alone only works if the element was truly focused.
      el.blur();
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return false;
    case ActionType.FILL:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus(); // focus first so a later blur commits (onBlur editors)
        return setNativeValue(el, asString(args['value']));
      }
      throw new Error(`cannot fill a <${el.tagName.toLowerCase()}>`);
    case ActionType.TYPE:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        return setNativeValue(el, el.value + asString(args['text']));
      }
      throw new Error(`cannot type into a <${el.tagName.toLowerCase()}>`);
    case ActionType.CLEAR:
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return setNativeValue(el, '');
      }
      return false;
    case ActionType.SELECT:
      if (el instanceof HTMLSelectElement) {
        el.value = asString(args['value']);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false; // change is not cancelable.
      }
      throw new Error(`cannot select on a <${el.tagName.toLowerCase()}>`);
    case ActionType.CHECK:
    case ActionType.UNCHECK:
      if (el instanceof HTMLInputElement) {
        el.checked = action === ActionType.CHECK;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
      }
      throw new Error(`cannot (un)check a <${el.tagName.toLowerCase()}>`);
    case ActionType.SUBMIT: {
      const form = el instanceof HTMLFormElement ? el : el.closest('form');
      if (form === null) throw new Error('no form to submit');
      form.requestSubmit();
      return false; // requestSubmit() returns void; the internal submit event is unobservable.
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
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
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
      const resolved = toRef !== undefined ? refs.resolve(toRef) : null;
      return await dragElement(el, resolved instanceof HTMLElement ? resolved : null, args['data']);
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
  const obs = new MutationObserver((records) => {
    mutated += records.length;
  });
  obs.observe(el.ownerDocument.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  let defaultPrevented = false;
  let settled = false;
  let settleReason: SettleReason | null = null;
  try {
    defaultPrevented = await dispatchFor(el, action, args);
  } finally {
    // bounded settle — microtask + one BOUNDED frame so React's commit (and the resulting DOM
    // mutations → dom.added/dom.text/dom.attr events) flush before we return, landing inside
    // observe({ since }). Bounded so a throttled/background tab never hangs; a settle timeout NEVER
    // rejects (only a real dispatch failure thrown above does). settle() can never throw.
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
    occluded: geometry.occluded,
    occludedBy: geometry.occludedBy,
    scrolledIntoView: geometry.scrolledIntoView,
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
  testid?: string;
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
    if (res.warning !== undefined) stepBase.warning = res.warning;
    stepResults.push(stepBase);
  }
  return { ok: true, count: steps.length, effects, steps: stepResults };
}

import {
  ActionType,
  ActionWarning,
  clampHoldMs,
  DANGEROUS_ACTION_CONFIRM_ARG,
  ElementState,
  NATIVE_INPUT_ARG,
  SettleReason,
} from '@reticlehq/core';
import { isHiddenNativeOption } from '@/dom/query.js';
import { isReticleUi } from '@/dom/dom-ignore.js';
import { asSyntheticInput } from './synthetic/synthetic-input.js';
import { echoRef, refs } from '@/dom/addressing/refs.js';
import {
  requiresDangerousConfirmation,
  assertOutwardAllowed,
  assertPaymentEntryAllowed,
  submitControlFor,
} from './danger-context.js';
import {
  assertEditable,
  assertNotRichText,
  isAutofillSafeTarget,
  setNativeValue,
} from './value-input.js';
import { isVisible, getStates, parentAcrossShadowBoundary } from '@/dom/a11y.js';
import { elementHasHoverHandlers } from '@/registry/stores/adapters.js';
import {
  type ActionTarget,
  isActionTarget,
  isForm,
  isInput,
  isLabel,
  isSelect,
  isTextArea,
} from '@/dom/realm.js';
import { asSettleBudget, nativeSetTimeout, settle } from '@/timers/native/native-timers.js';
import { publishSettledField, watchActedField } from '@/observers/field.js';
import { AppearedText } from './appeared-text.js';
import { alreadyAtCheckedState, assertAriaToggleLanded, isAriaToggle } from './check-state.js';
import {
  focusedOrDocument,
  isReflessDocumentPress,
  pressCode,
  pressKey,
  pressModifiers,
  pressKeys,
  holdKey,
  pressCombo,
  dispatchKeypress,
  closeModalOnEscape,
  keyboardEvent,
} from './actions-press.js';
import { anchorOf, result, type ActionEffect, type ActionResult } from './action-report.js';

function asString(value: unknown, fallback = ''): string {
  return 'string' === typeof value ? value : fallback;
}

function requireElement(ref: string): ActionTarget {
  const el = refs.resolve(ref);
  if (null === el) throw new Error(`ref '${echoRef(ref)}' no longer resolves to an element`);
  if (!isActionTarget(el)) throw new Error(`ref '${echoRef(ref)}' is not an HTML or SVG element`);
  return el;
}

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
const CLICK_LIKE = new Set<string>([
  ActionType.CLICK,
  ActionType.DBLCLICK,
  // check/uncheck activate through a real click, so they need everything a click needs: the point
  // geometry, the off-viewport scroll, the occlusion hit-test, and the component/source attribution.
  // Their absence here makes a `check` come back with no `component` while a `click` on the same
  // element carries one.
  ActionType.CHECK,
  ActionType.UNCHECK,
]);

/**
 * What the destructive-action guard classifies: the ELEMENT, and nothing rendered around it.
 *
 * NOT `form?.textContent`: the whole enclosing form's rendered text would decide the verdict for
 * every control inside it, so a settings form with per-row "Remove" buttons reads its own Save button
 * as destructive — intermittently, depending on whether the rows have rendered. The way past that is
 * `confirmDangerous: true` on every click, and a guard that fires on everything gets switched off.
 *
 * The form's `action` stays — that is a URL this element submits to, i.e. a property of what this
 * click DOES, not of what happens to be on screen beside it.
 */

/**
 * The drop target a `drag` names, under either spelling.
 *
 * `toRef` is what the source has always read and it appears NOWHERE in the tool description an
 * agent sees — the `args` sentence names `value`, `text`, `native`, `holdMs` and `confirmDangerous`
 * and omits the one argument without which this action cannot do its job. So agents guess, and
 * `target` is the guess they make. Accepting it costs nothing and removes a whole class of
 * silently-target-less drags; the description now documents `toRef` as well.
 */
function dragTargetRef(args: Record<string, unknown>): string {
  const named = asString(args['toRef']);
  return '' !== named ? named : asString(args['target']);
}

/**
 * The keys `upload` actually reads, and the generic ones every action accepts.
 *
 * `path` and `__base64` are NOT listed here. `path` is intercepted by the daemon before the
 * command reaches the browser and rewritten to `{ content, name, type, __base64: true }`. If a
 * `path` key arrives at the browser without a daemon in the loop, `assertUploadArgs` correctly
 * refuses it — the guard exists precisely to prevent a filename-only call from uploading fabricated
 * bytes under the right name. The browser cannot read disk files; the daemon is the only valid
 * path for that crossing.
 */
const UPLOAD_ARG_KEYS: ReadonlySet<string> = new Set(['content', 'name', 'type', '__base64']);
const GENERIC_ACTION_ARG_KEYS: ReadonlySet<string> = new Set([
  DANGEROUS_ACTION_CONFIRM_ARG,
  NATIVE_INPUT_ARG,
  'holdMs',
]);

/**
 * An `upload` must have been told what to upload.
 *
 * The branch below defaults every field, so a call whose keys were all unrecognised — the field
 * report sent `args.files` — manufactured a 17-byte `file.txt` reading "reticle test file", uploaded
 * THAT, and returned ok:true. The server answered 200, the UI refreshed, and every signal the agent
 * could read said its PDF had been processed. That is a manufactured green on the write path, the
 * same shape `drag` refuses one branch below.
 *
 * Both halves matter. A call with no recognised key at all never described a file; a call that mixes
 * one in with a dropped one (`{ files, name }`) is worse, because the right filename arrives attached
 * to invented bytes. A name-only call keeps working: the placeholder body is documented and the
 * caller that omitted `content` knows it did.
 *
 * `path` is a recognised key: when a daemon is in the loop it reads the file and rewrites the call
 * to `{ content, name, type }` before it arrives here. When there is no daemon, `path` is accepted
 * and the name is used correctly — the placeholder body is the documented default, not fabrication,
 * because the caller chose to name a path that cannot be read in-browser. This is worse than the
 * daemon path, but better than a refusal that tells the agent "upload does not support paths".
 *
 * The refusal names the keys upload reads so a caller that guessed can correct in one turn. Scoped
 * to upload: it is the one action where a dropped key is replaced with fabricated content.
 */
function assertUploadArgs(args: Record<string, unknown>): void {
  const keys = Object.keys(args);
  const dropped = keys.filter((k) => !UPLOAD_ARG_KEYS.has(k) && !GENERIC_ACTION_ARG_KEYS.has(k));
  if (0 === dropped.length && keys.some((k) => UPLOAD_ARG_KEYS.has(k))) return;
  const detail =
    0 === dropped.length
      ? 'no file was described'
      : `upload does not read ${dropped.join(', ')}, so it would be dropped`;
  throw new Error(
    `upload needs the file described as args: { name, content?, type? } — ${detail}. ` +
      'To upload a file from disk, use the reticle daemon which reads it via args.path and ' +
      'delivers real bytes; calling with { path } directly reaches only fabricated content.',
  );
}

function assertActionAllowed(
  el: ActionTarget,
  action: string,
  args: Record<string, unknown>,
): void {
  const canTrigger =
    action === ActionType.CLICK ||
    action === ActionType.DBLCLICK ||
    action === ActionType.CHECK ||
    action === ActionType.UNCHECK ||
    action === ActionType.DRAG ||
    action === ActionType.SUBMIT ||
    // Read through the SAME resolver as the dispatch below. Reading a different argument here meant
    // the destructive-action guard classified the call by a key nobody had asked for.
    (action === ActionType.PRESS && 'Enter' === pressKey(args));
  // Same resolver as the dispatch below, so the destructive-action guard cannot classify a drag
  // by a target the dispatch will not use.
  const dragTarget = action === ActionType.DRAG ? refs.resolve(dragTargetRef(args)) : null;
  // Enter is judged by what it submits as well as by the field itself. Any OTHER key submits
  // nothing, so the form is none of its business.
  const submitter =
    action === ActionType.PRESS && 'Enter' === pressKey(args) ? submitControlFor(el) : null;
  if (canTrigger)
    assertOutwardAllowed([el, submitter, isActionTarget(dragTarget) ? dragTarget : null]);
  if (action === ActionType.FILL || action === ActionType.TYPE) assertPaymentEntryAllowed(el);
  const sourceDangerous =
    requiresDangerousConfirmation(el) ||
    (submitter !== null && requiresDangerousConfirmation(submitter));
  const targetDangerous = isActionTarget(dragTarget) && requiresDangerousConfirmation(dragTarget);
  if (
    canTrigger &&
    (sourceDangerous || targetDangerous) &&
    args[DANGEROUS_ACTION_CONFIRM_ARG] !== true
  ) {
    throw new Error(
      `potentially destructive action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
    );
  }
  if (CLICK_LIKE.has(action) && el instanceof HTMLElement && isHiddenNativeOption(el)) {
    throw new Error(
      'cannot click a native <option> inside a visually-hidden <select> — open the dropdown and target the visible option',
    );
  }
}

/** The value of the option `named` names: its value, else the one option whose label it is. */
function optionValueFor(options: readonly HTMLOptionElement[], named: string): string {
  if (options.some((option) => option.value === named)) return named;
  const byLabel = options.filter((option) => option.label.trim() === named.trim());
  return 1 === byLabel.length ? (byLabel[0]?.value ?? named) : named;
}

/** Best-effort click-point geometry. All-false default when there is nothing measurable to test. */
import {
  NO_GEOMETRY,
  fireClickSequence,
  fireTapSequence,
  clickGeometry,
  firePointer,
  firePointerNonBubbling,
  dragElement,
  mouseEventFor,
  assertNotLeaving,
} from './actions-dom.js';
import { scrollFrom } from './scroll.js';
import { clickHitsNoControl } from './click-target.js';

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
  el: ActionTarget,
  action: string,
  args: Record<string, unknown>,
): Promise<DispatchOutcome> {
  if (ActionType.CLICK === action) {
    // Full pointer/mouse sequence (not a bare click) so pointer- and focus-gated handlers fire the
    // way they do for a real user.
    //
    // `args.holdMs` keeps the pointer down in between, which is the only way to drive a
    // hold-to-confirm control. Capped: an unbounded hold is a tool call that never returns.
    const hold = clampHoldMs(args['holdMs']);
    return await fireClickSequence(
      el,
      0 === hold ? undefined : { ms: hold, sleep, now: () => Date.now() },
    );
  }
  if (ActionType.TAP === action) {
    // A finger, not a mouse. `holdMs` makes it a long press — the gesture behind a context menu or
    // a reorder handle, which has no mouse equivalent worth pretending about.
    const hold = clampHoldMs(args['holdMs']);
    return await fireTapSequence(
      el,
      0 === hold ? undefined : { ms: hold, sleep, now: () => Date.now() },
    );
  }
  return { prevented: await dispatchOther(el, action, args), heldMs: 0 };
}

/**
 * Why an in-page zoom is refused. Exported so the server and the SDK say the identical sentence.
 */
export const ZOOM_NEEDS_REAL_BROWSER_MSG =
  'cannot zoom from inside the page — CSS zoom changes how it LOOKS without changing the layout ' +
  'viewport, visualViewport or media queries, so a layout that breaks at 200% would be reported as ' +
  'checked and passing. Drive a real browser (reticle drive <url>, or reticle_lease) and zoom there.';

/** A finite number from the wire, or undefined. Non-numbers are "not asked for", never zero. */
function asFiniteNumber(raw: unknown): number | undefined {
  return 'number' === typeof raw && Number.isFinite(raw) ? raw : undefined;
}

async function dispatchOther(
  el: ActionTarget,
  action: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  switch (action) {
    case ActionType.DBLCLICK:
      await fireClickSequence(el, undefined, 1);
      await fireClickSequence(el, undefined, 2);
      return !asSyntheticInput(() =>
        el.dispatchEvent(
          mouseEventFor(el, 'dblclick', { bubbles: true, cancelable: true, detail: 2 }),
        ),
      );
    case ActionType.HOVER: {
      const doc = el.ownerDocument;
      // Best-effort "previous" node for relatedTarget so React's enter/leave synthesis has a "from".
      const from: EventTarget = doc.activeElement ?? doc.body;
      // Bubbling over/move with relatedTarget so React's delegated root can synthesize enter/leave.
      firePointer(el, 'pointerover', from);
      el.dispatchEvent(mouseEventFor(el, 'mouseover', { bubbles: true, relatedTarget: from }));
      // Non-bubbling enter pair (per spec) for direct enter/onMouseEnter listeners.
      firePointerNonBubbling(el, 'pointerenter', from);
      el.dispatchEvent(mouseEventFor(el, 'mouseenter', { relatedTarget: from }));
      firePointer(el, 'pointermove', from);
      const moved = el.dispatchEvent(
        mouseEventFor(el, 'mousemove', { bubbles: true, cancelable: true }),
      );
      // hover-dwell: keep "hovering" for holdMs so timer-gated reveals can mount. Capped like
      // click's: unbounded, it is the same never-returns hazard.
      const holdMs = clampHoldMs(args['holdMs']);
      if (holdMs > 0) await sleep(holdMs);
      return !moved;
    }
    case ActionType.FOCUS:
      el.focus();
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return false; // FocusEvents are not cancelable.
    case ActionType.BLUR: {
      // React 19 listens for `focusout` at the ROOT, so a commit-on-blur handler needs a BUBBLING
      // event to reach it — and `el.blur()` is a no-op on an element that was never focused, which
      // is why the synthetic pair exists at all.
      //
      // But on a FOCUSED element `el.blur()` already dispatches `blur` and a bubbling `focusout`
      // natively. Dispatching them again makes React run `onBlur` TWICE, and the resulting double
      // write is reported as a `duplicate-request` contradiction — an invented defect handed to a
      // human as real.
      //
      // So synthesize ONLY when nothing native will fire. Read before the call, because `blur()` is
      // what changes it — and read off the element's own ROOT: `document.activeElement` reports the
      // shadow HOST for an element inside a shadow root, so an element that genuinely was focused
      // would read as unfocused and take the double-dispatch path this exists to prevent. Both
      // Document and ShadowRoot expose `activeElement`, so one expression covers both.
      const root = el.getRootNode() as Document | ShadowRoot;
      const wasFocused = root.activeElement === el;
      el.blur();
      if (!wasFocused) {
        el.dispatchEvent(new FocusEvent('blur'));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      }
      return false;
    }
    case ActionType.FILL:
      if (isInput(el) || isTextArea(el)) {
        // A MISSING value is a malformed call, not a request to empty the field: defaulting it to ''
        // wiped a login form's email and reported success. An explicit '' still clears.
        if (typeof args['value'] !== 'string') {
          throw new Error(
            "fill requires a string `value` — pass it nested, as args: { value: '…' }. " +
              'To empty a field on purpose use the `clear` action, or fill with an explicit "".',
          );
        }
        assertEditable(el, 'fill');
        // Focus so a later blur commits; not a WebKit password field, where it raises AutoFill.
        if (!isAutofillSafeTarget(el)) el.focus();
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
        const options = Array.from(el.options);
        // An option is named by its value, or by the label a person reads on it when exactly one
        // option carries that label: "Only if “Sign in” passed" was refused with its own label.
        const wanted = optionValueFor(options, args['value']);
        // REFUSE an option that does not exist, before touching the element.
        //
        // Assigning anyway and reporting the resulting `valueChanged` delta as proof the option
        // never took only works if nobody is listening. An unmatched value drives selectedIndex to
        // -1, so `el.value` becomes '' — and `change` is then dispatched, so the app reads that empty
        // value in its handler and persists it. The "detectable no-op" mutates the app into a state
        // no user could reach AND does it through the app's own handler.
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
    case ActionType.UNCHECK: {
      const aria = isAriaToggle(el);
      if (!isInput(el) && !aria) {
        throw new Error(`cannot (un)check a <${el.tagName.toLowerCase()}>`);
      }
      // Same rule as the readonly/disabled refusal on fill: if a real user could not do it, forcing
      // it is not a test, it is damage — and a green over it is a false one.
      if (!enabledOf(el)) {
        throw new Error(
          `cannot ${action} a disabled control — a real user could not, so neither will Reticle`,
        );
      }
      // A radio is deselected by selecting another radio, never on its own. Refusing is the same
      // rule as the disabled control above: a state no user could reach must not be forced.
      // An ARIA toggle has no native toggle: the full click sequence, then the app flips it.
      if (!isInput(el)) {
        return alreadyAtCheckedState(el, action) ? false : (await fireClickSequence(el)).prevented;
      }
      if ('radio' === el.type && action === ActionType.UNCHECK) {
        throw new Error(
          'cannot uncheck a radio button — a real user could not; select another radio in the group',
        );
      }
      // Already there: touch nothing. `check` means "end up checked", not "toggle", so clicking here
      // would flip it OFF, and SETTING it would hand the app an `input`/`change` no user produced —
      // enough to make an app that autosaves, logs or POSTs on change act on a no-op. Reported as
      // `effect.alreadyAtValue` — the same predicate, read again by executeAction — because "nothing
      // was dispatched" is not the same claim as "the app holds this value". See ActionEffect.
      if (alreadyAtCheckedState(el, action)) return false;
      // A real click, never `el.checked = …`. Assigning the property flips the pixel and tells no
      // framework: React binds a checkbox's onChange to the CLICK event, and its value tracker dedups
      // the change it would otherwise synthesise from a direct assignment — so a controlled
      // `checked={state}` box never heard from us while the action reported success.
      //
      // Dispatched rather than `el.click()` so cancellation is read off the event object itself. The
      // old probe listened on `window`, which never runs when a handler calls `stopPropagation()`, so
      // a cancelled activation was reported as a successful one. Activation behaviour runs either way
      // — a synthetic click toggles the box, which `adversarial.check.test.ts` pins, because the
      // comment this replaces asserted the opposite and was wrong.
      const event = mouseEventFor(el, 'click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      // Marked as ours so the annotator's capture-phase listener lets it through: in annotate mode
      // it cancels clicks to place a mark, which would otherwise swallow every action we dispatch.
      const notPrevented = asSyntheticInput(() => el.dispatchEvent(event));
      return !notPrevented || event.defaultPrevented;
    }
    case ActionType.SUBMIT: {
      const form = isForm(el) ? el : el.closest('form');
      if (null === form) throw new Error('no form to submit');
      form.requestSubmit();
      return false; // requestSubmit returns void; the internal submit event is unobservable.
    }
    case ActionType.PRESS: {
      const mods = pressModifiers(args);
      const combo = pressKeys(args);
      // SEVERAL keys held together, released in reverse — what a keyboard physically does.
      // `modifiers` cannot express this: they are flags on ONE event, so "Control held while k and
      // then j are struck" had no spelling at all.
      if (combo.length > 0) return await pressCombo(el, combo, mods, clampHoldMs(args['holdMs']));
      const key = pressKey(args);
      const code = pressCode(args, key);
      // Marked as ours like the click sequence: the annotator leaves annotate mode on Escape, so an
      // agent pressing Escape would otherwise switch off a mode the person turned on.
      const down = asSyntheticInput(() =>
        el.dispatchEvent(
          keyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }),
        ),
      );
      closeModalOnEscape(el, key, down); // on keydown, as a browser does, before any hold
      if (down) dispatchKeypress(el, key, code, mods);
      // A HELD key, with the auto-repeat a browser sends while it is down.
      //
      // The mouse has had `holdMs` since hold-to-confirm; the keyboard did not, so a key that has to
      // be held — a game control, hold-to-delete, a press-and-hold reveal — was undriveable while
      // the identical gesture with a mouse button worked. The asymmetry was the bug.
      const hold = clampHoldMs(args['holdMs']);
      if (hold > 0) await holdKey(el, key, code, mods, hold);
      asSyntheticInput(() =>
        el.dispatchEvent(keyboardEvent('keyup', { key, code, bubbles: true, ...mods })),
      );
      return !down;
    }
    case ActionType.SCROLL_INTO_VIEW:
      el.scrollIntoView();
      return false;
    case ActionType.ZOOM:
      /*
       * Page zoom cannot be done from inside the page, so this REFUSES rather than approximating it.
       *
       * `document.documentElement.style.zoom` and a CSS transform both look like zoom in a
       * screenshot and are not it: the layout viewport does not change, `visualViewport` does not
       * change, media queries do not re-evaluate, and `position: fixed` behaves differently. A
       * layout that breaks at 200% browser zoom would therefore be reported as CHECKED and passing,
       * which is worse than not supporting zoom at all.
       *
       * Same rule as `hover`, which refuses without a native pointer for the same reason: a
       * synthetic mouseover reports success while CSS `:hover` never ran. The driven path
       * (`reticle drive`, a lease, or a CDP attach) is where zoom is real, and `tryRealInput`
       * routes there before this ever runs.
       */
      throw new Error(ZOOM_NEEDS_REAL_BROWSER_MSG);
    case ActionType.SCROLL: {
      // Either axis, either direction. `dy: -600` scrolls BACK up, `dx` moves a wide table sideways.
      // Both were unreachable: the only scroll stepped down, so anything that scrolled past was gone.
      const dy = asFiniteNumber(args['dy']);
      const dx = asFiniteNumber(args['dx']);
      const fraction = asFiniteNumber(args['fraction']);
      scrollFrom(el, dy, fraction, dx);
      return false;
    }
    case ActionType.UPLOAD: {
      const input = isInput(el) && 'file' === el.type ? el : resolveUploadInput(el);
      assertUploadArgs(args);
      // When the daemon read a file from disk it base64-encoded the bytes so they survive JSON
      // serialisation across the bridge. Decode back to binary before handing to the File API.
      // Without this the browser would treat the base64 string as UTF-16 text, and the app
      // would receive garbled bytes — correct name and type, wrong payload, still a false green.
      const rawContent = asString(args['content'], 'reticle test file');
      let fileBody: BlobPart = rawContent;
      if (true === args['__base64']) {
        const bin = atob(rawContent);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        // Use slice(0) to get a plain ArrayBuffer from the Uint8Array's backing store.
        // arr.buffer is SharedArrayBuffer-typed in strict tsconfigs; slice(0) narrows it to
        // ArrayBuffer and avoids the type assertion the linter would flag.
        fileBody = arr.buffer.slice(0);
      }
      const file = new File([fileBody], asString(args['name'], 'file.txt'), {
        type: asString(args['type'], 'text/plain'),
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      const inputOk = input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return !inputOk;
    }
    case ActionType.DRAG: {
      const toRef = dragTargetRef(args);
      // asString falls back to '' (never undefined), so the old `!== undefined` was always true and
      // handed '' to refs.resolve. A drag with NO target named is a free drag — resolve nothing.
      if ('' === toRef) return await dragElement(el, null, args['data']);
      // A target WAS named and did not resolve. That is a malformed call, not a free drag: dragging
      // nowhere and reporting `ok: true` is a false green, and a guessed target name reads as "no
      // target" while every effect field looks healthy.
      const resolved = refs.resolve(toRef);
      if (!isActionTarget(resolved)) {
        throw new Error(
          `drag target '${echoRef(toRef)}' did not resolve to an element — pass a ref from ` +
            'reticle_snapshot or reticle_query as args.toRef (alias: args.target)',
        );
      }
      return await dragElement(el, resolved, args['data']);
    }
    default:
      throw new Error(`unknown action '${action}'`);
  }
}

/** Every file input inside a scope, in document order. */
function fileInputsIn(scope: Element | ShadowRoot): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll('input[type="file"]')).filter(isInput);
}

/** The refusal every upload resolution failure shares: the target is not a file input. */
const UPLOAD_TARGET_MUST_BE_FILE_INPUT = 'upload target must be a <input type="file">';

/**
 * The interactive controls that bound the upload walk: a decision past one of these is a
 * guess. A `label`, a `summary`, and anything focusable or given a role count as controls:
 * a header whose only control is a label that wraps its file input is still another part
 * of the page, not part of the dropzone.
 */
const INTERACTIVE_CONTROL_SELECTOR =
  'button, a, input, select, textarea, label, summary, [role], [tabindex], [contenteditable]';

/**
 * Whether `queryRoot` holds an interactive control that is neither the upload target nor a
 * file input. The target and the file inputs are the two things the walk is allowed to see.
 * Anything else — the header's avatar menu button, a form's Save button — means the input the
 * walk would decide on belongs to another part of the page, so the walk stops here. One
 * exception keeps a file input a control: an input with its own wrapping label is that
 * label's control, so it counts when the label does not also wrap the target.
 */
function holdsOtherInteractiveControl(
  queryRoot: Element | ShadowRoot,
  target: ActionTarget,
): boolean {
  const controls = queryRoot.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR);
  return Array.from(controls).some((control) => {
    if (control === target) return false;
    if (isInput(control) && 'file' === control.type) {
      const wrappingLabel = control.closest('label');
      return null !== wrappingLabel && !wrappingLabel.contains(target);
    }
    return true;
  });
}

/**
 * The file input an `upload` on a non-input target means (#1249).
 *
 * The standard dropzone pattern hides the input (`sr-only`, `aria-hidden`) behind a Browse
 * button. The snapshot skips `aria-hidden` subtrees, so the input never gets a ref and the
 * button is the only target the agent can name. Resolve the input the target labels first (a
 * label target, or the label that wraps the target), then walk outward from the target.
 *
 * The walk is bounded two ways. It stops at the first ancestor that holds an interactive
 * control other than the target and the file inputs: a button, link, input, select,
 * textarea, label, summary, or anything with a role, a tabindex, or contenteditable. Past
 * that point the input the walk would decide on belongs to another part of
 * the page — most apps wrap the whole page in a `<div id="root">`, so a wrapper scope
 * would otherwise hand a Browse button with an empty dropzone the header's avatar input,
 * and the upload would report a success the app never saw. The nearest enclosing form is
 * the last scope it queries, and it never decides at `body` or `html`, for the same
 * reason. More than one input in the deciding scope is a refusal, never a guess. At the
 * top of a shadow tree the walk queries the shadow root itself before hopping to the host,
 * so a dropzone inside a shadow root resolves.
 */
function resolveUploadInput(el: ActionTarget): HTMLInputElement {
  const label = isLabel(el) ? el : el.closest('label');
  const labeled = label?.control;
  if (isInput(labeled) && 'file' === labeled.type) return labeled;

  let scope: Element | null = el;
  let aboveTarget = false;
  while (null !== scope) {
    if ('BODY' !== scope.tagName && 'HTML' !== scope.tagName) {
      const shadowRoot = shadowRootAbove(scope);
      const queryRoot = shadowRoot ?? scope;
      // The control check runs on any pass past the target, and on the first pass when the
      // target sits directly under a shadow root: that pass reads the whole shadow root,
      // so a root that holds another control must refuse here, not decide on its input.
      if ((aboveTarget || null !== shadowRoot) && holdsOtherInteractiveControl(queryRoot, el)) {
        throw new Error(UPLOAD_TARGET_MUST_BE_FILE_INPUT);
      }
      const only = onlyFileInputIn(scope);
      if (undefined !== only) return only;
    }
    if (isForm(scope)) break;
    scope = parentAcrossShadowBoundary(scope);
    aboveTarget = true;
  }
  throw new Error(UPLOAD_TARGET_MUST_BE_FILE_INPUT);
}

/**
 * The single file input `scope` holds, or undefined when it holds none. Throws when it holds
 * more than one: setting files on the wrong input reports a success the app never saw.
 */
function onlyFileInputIn(scope: Element): HTMLInputElement | undefined {
  // At the top of a shadow tree, query the root itself: the composed parent is the host, but
  // the host's `querySelectorAll` cannot see shadow children. The root contains the scope, so
  // one query covers both.
  const found = fileInputsIn(shadowRootAbove(scope) ?? scope);
  if (1 < found.length) {
    throw new Error(
      `upload target is not a file input and its scope holds ${found.length} file inputs — ` +
        'target the file input itself so the upload cannot land on the wrong one',
    );
  }
  return found[0];
}

/**
 * The shadow root `scope` sits directly under, or null. Duck-typed on `host` the way a11y.ts
 * does: `instanceof ShadowRoot` fails across realms, and `host` exists on a ShadowRoot and not
 * on a Document.
 */
function shadowRootAbove(scope: Element): ShadowRoot | null {
  if (null !== scope.parentElement) return null;
  const root = scope.getRootNode() as Partial<ShadowRoot>;
  return undefined === root.host ? null : (root as ShadowRoot);
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
  const named = 0 < ref.length;
  const el = isReflessDocumentPress(ref, action, args) ? focusedOrDocument() : requireElement(ref);
  // A document-key press is not aimed at the element we dispatch on. The destructive-action
  // guard classifies the ELEMENT, and inventing a target from body/focus would be the lie this
  // path exists to avoid.
  if (named) assertActionAllowed(el, action, args);
  if (named) assertNotLeaving(el);
  // Capture the anchor while the element is still mounted — the action may unmount it (navigation).
  // A refless press reports no anchor: minting a testid/component of whatever is focused would
  // invent a target the caller did not name.
  const anchor = named ? anchorOf(el) : {};
  const visible = isVisible(el);
  const enabled = enabledOf(el);
  const prevFocus = activeRef(el);
  const valueBefore = valueOf(el);
  // Before dispatch, so a click that toggles `checked` during the event cannot erase the pre-action
  // reading, and so a script write during the action is seen. Published after settle, once React
  // has restored or committed the controlled property.
  const actedField = watchActedField(el);
  // Click-like: scroll an off-viewport target in + hit-test the click point BEFORE installing the
  // mutation observer (scroll/hit-test never mutate the DOM, but keep the probe window clean).
  const geometry = CLICK_LIKE.has(action) ? clickGeometry(el) : NO_GEOMETRY;
  // Read BEFORE dispatch, from the same predicate the dispatch branch uses.
  const alreadyAtValue = alreadyAtCheckedState(el, action);
  const hitsNoControl = clickHitsNoControl(el, action);

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
    // BURST: a caller provoking a race needs the next action dispatched while this one is still in
    // flight. The default budget is a bounded frame, but in a throttled/headless tab rAF never fires
    // and the full FRAME_BUDGET_MS fallback burns on EVERY step — measured at ~500ms between two
    // `act_sequence` clicks, which serialises them and suppresses the very interleaving the caller
    // was trying to cause. `args.settleMs: 0` drains the microtask queue and returns.
    //
    // Named after what it costs: a zero budget means DOM mutations from this action may land after
    // the call returns, so `settled` is false and the effect block is thinner. That is the trade a
    // race-provoking caller is explicitly asking for, and no other caller gets it by accident.
    const budget = asSettleBudget(args['settleMs']);
    const outcome = await settle(budget);
    settled = outcome.settled;
    settleReason = outcome.settled ? null : SettleReason.TIMEOUT;
    obs.disconnect();
    actedField?.stop();
  }

  assertAriaToggleLanded(el, action, alreadyAtValue);
  const valueAfter = valueOf(el);
  publishSettledField(el, actedField);
  const nextFocus = activeRef(el);
  const effect: ActionEffect = {
    dispatched: true,
    targetMatched: named && el.isConnected,
    visible,
    enabled,
    defaultPrevented,
    focusMoved: prevFocus !== nextFocus ? `${prevFocus ?? 'null'}->${nextFocus ?? 'null'}` : null,
    valueChanged: isFillLike(action) ? valueBefore !== valueAfter : false,
    ...(ActionType.FILL === action && isAutofillSafeTarget(el) ? { autofillSafe: true } : {}),
    domMutatedWithin: mutated,
    // Omitted rather than "" when nothing was said — an empty string reads as "it said nothing
    // meaningful", where absence says "it added no text at all". Those are different findings.
    ...said.effect(valueAfter),
    occluded: geometry.occluded,
    occludedBy: geometry.occludedBy,
    scrolledIntoView: geometry.scrolledIntoView,
    // Omitted unless they apply: each names a reason a person could not have made this click.
    ...(geometry.occluderName === undefined ? {} : { occluderName: geometry.occluderName }),
    ...(true === geometry.noSize ? { noSize: true as const } : {}),
    ...(true === geometry.offViewport ? { offViewport: true as const } : {}),
    // Omitted when there was no hold: an absent key says "this action does not hold", where a 0
    // would read as "it held for no time", which is a different and misleading claim.
    ...(heldMs > 0 ? { heldMs } : {}),
    // Omitted unless it applies: an absent key means the action actually drove the control (or is
    // not a check at all), which is the only reading that must not be ambiguous.
    ...(alreadyAtValue ? { alreadyAtValue: true as const } : {}),
  };
  // Honesty caveats: a visually-occluded click is reported even though synthetic dispatch landed;
  // else synthetic hover may not fire framework enter/leave handlers (no native hit-test).
  // A document-key press did not resolve a named target — say so rather than describing body.
  const warning = !named
    ? ActionWarning.GLOBAL_PRESS
    : geometry.occluded
      ? ActionWarning.CLICK_OCCLUDED
      : action === ActionType.HOVER && elementHasHoverHandlers(el)
        ? ActionWarning.HOVER_NATIVE_ENTER_LEAVE
        : hitsNoControl
          ? ActionWarning.CLICK_NOT_A_CONTROL
          : undefined;
  const done = result(ref, action, effect, settled, settleReason, anchor, warning);
  // Only reachable with the HUD exposed: said so the recorder keeps it out of the app's flows.
  return isReticleUi(el) ? { ...done, reticleUi: true } : done;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => nativeSetTimeout(r, ms));

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
  secret?: true;
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
    if (res.secret !== undefined) stepBase.secret = res.secret;
    if (res.warning !== undefined) stepBase.warning = res.warning;
    stepResults.push(stepBase);
  }
  return { ok: true, count: steps.length, effects, steps: stepResults };
}

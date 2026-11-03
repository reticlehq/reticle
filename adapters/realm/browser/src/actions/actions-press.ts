import { ActionType, isGlobalPress, pressKeyFromArgs, pressKeysFromArgs } from '@reticlehq/core';
import { asSyntheticInput } from './synthetic/synthetic-input.js';
import { nativeSetTimeout } from '@/timers/native/native-timers.js';

/** Native, so a page that patched setTimeout cannot stretch or stall a hold. */
const sleep = (ms: number): Promise<void> => new Promise((r) => nativeSetTimeout(r, ms));
import { type ActionTarget, isHtmlElement } from '@/dom/realm.js';

function asString(value: unknown, fallback = ''): string {
  return 'string' === typeof value ? value : fallback;
}

/**
 * Which key a `press` is asking for. Delegates to the core helper so the server locator and the
 * in-page dispatcher cannot disagree about `text` vs `key` vs the Enter default.
 */
export function pressKey(args: Record<string, unknown>): string {
  return splitChord(pressKeyFromArgs(args)).key;
}

/**
 * A Playwright-style chord, `Meta+/` or `Control+Shift+K`: the modifiers before the last `+`, and the
 * key after it, with a key named by its code (`Slash`) turned into its character. Sent whole, the
 * chord was ONE keydown whose key was the literal "Meta+/", with no flag and no code (#2139). A
 * string whose prefix is not all modifier names is not a chord, and stays as it is.
 */
function splitChord(raw: string): { key: string; flags: (keyof ModifierFlags)[] } {
  const at = raw.lastIndexOf('+', raw.length - 2);
  const flags =
    0 < at
      ? raw
          .slice(0, at)
          .split('+')
          .map((name) => MODIFIER_FLAG_ALIASES[name.toLowerCase()])
      : [];
  if (0 === flags.length || flags.some((flag) => flag === undefined)) {
    return { key: CODE_KEYS[raw] ?? raw, flags: [] };
  }
  const key = raw.slice(at + 1);
  return { key: CODE_KEYS[key] ?? key, flags: flags.filter((flag) => flag !== undefined) };
}

/** The four modifier flags a KeyboardEvent carries. */
export interface ModifierFlags {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Every flag `ModifierFlags` carries, spelled once.
 *
 * Read where a flag has to be found from the SHAPE of the interface rather than from a key or an
 * alias — seeding the hold count from `args.modifiers`, below. A literal list there would silently
 * miss a fifth flag the day one is added, and the symptom would be a flag that clears early.
 */
const MODIFIER_FLAG_KEYS: readonly (keyof ModifierFlags)[] = [
  'metaKey',
  'ctrlKey',
  'shiftKey',
  'altKey',
];

/**
 * Which flag a modifier NAME sets. One table for both spellings of "a modifier is down":
 * `args.modifiers`, which is a fixed set of flags for the whole press, and `args.keys`, which is a
 * SEQUENCE the flags change partway through. Two tables would let `Ctrl` mean one thing in
 * `modifiers` and another in `keys`.
 */
const MODIFIER_FLAG_ALIASES: Readonly<Record<string, keyof ModifierFlags>> = {
  meta: 'metaKey',
  cmd: 'metaKey',
  command: 'metaKey',
  super: 'metaKey',
  win: 'metaKey',
  control: 'ctrlKey',
  ctrl: 'ctrlKey',
  shift: 'shiftKey',
  alt: 'altKey',
  option: 'altKey',
  opt: 'altKey',
};

/**
 * Modifier flags for a `press`, from `args.modifiers`: an array of Meta / Control / Shift / Alt
 * (case-insensitive, with the usual aliases). Without them a Cmd+K / Ctrl+Shift shortcut receives a
 * keydown with every modifier false, so the app's own `event.metaKey` check never matches and
 * nothing observable happens -- a false negative Reticle reports as no error. (#393)
 */
export function pressModifiers(args: Record<string, unknown>): ModifierFlags {
  const raw = args['modifiers'];
  const names = Array.isArray(raw) ? raw.map((m) => asString(m).toLowerCase()) : [];
  const flags: ModifierFlags = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  for (const name of names) {
    const flag = MODIFIER_FLAG_ALIASES[name];
    if (flag !== undefined) flags[flag] = true;
  }
  // The modifiers a chord names in `key` (`Meta+/`) hold as well as the ones in `modifiers`.
  for (const flag of splitChord(pressKeyFromArgs(args)).flags) {
    flags[flag] = true;
  }
  return flags;
}

/**
 * The flag a key NAMED IN `keys` holds down while the sequence continues, or undefined for a key
 * that is not a modifier.
 */
function modifierFlagFor(key: string): keyof ModifierFlags | undefined {
  return MODIFIER_FLAG_ALIASES[key.toLowerCase()];
}

/**
 * The PHYSICAL key identity — `event.code` — derived from the logical key.
 *
 * A real browser always sends both, and a meaningful class of library reads only `code`, because it
 * is the layout-independent one: dnd-kit's KeyboardSensor matches its activation and arrow keys on
 * it, and so does react-aria. With `key` alone those handlers never match — the event fires, the
 * listener runs, the guard fails, and the action reports dispatched over an app that did nothing.
 *
 * An explicit `code` always wins: a caller driving a non-US layout knows something this derivation
 * cannot. And an unrecognised multi-character key yields `''` rather than a guess — a wrong `code`
 * is worse than none, because a handler will act on it.
 */
export function pressCode(args: Record<string, unknown>, key: string): string {
  const explicit = args['code'];
  if ('string' === typeof explicit && 0 < explicit.length) return explicit;
  if (' ' === key) return 'Space';
  if (1 === key.length) {
    if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
    // Punctuation: the key a US-layout keyboard presses for it, as Playwright assumes (#2139). A
    // handler that reads `code` matched nothing when it was empty. Another layout passes `code`.
    return PUNCTUATION_CODES[key] ?? '';
  }
  // Named keys — 'Enter', 'Escape', 'Tab', 'ArrowDown' — already ARE their own code.
  return /^[A-Z][A-Za-z0-9]*$/.test(key) && KNOWN_NAMED_KEYS.has(key) ? key : '';
}

/**
 * Dispatch the legacy `keypress` event a real browser still emits for character-producing keys.
 *
 * `keypress` is deprecated, but kiosk/POS apps and scanner integrations still listen for it. A
 * synthetic `press` that only sends keydown/keyup therefore reports success while those apps never
 * receive the scan. Keep this deliberately narrow: printable single-character keys and Enter only,
 * never navigation or modifier keys.
 *
 * The caller is responsible for checking the preceding keydown result. Browsers do not emit
 * keypress when keydown was cancelled.
 */
export function dispatchKeypress(
  el: ActionTarget,
  key: string,
  code: string,
  mods: ModifierFlags,
  repeat = false,
): void {
  if (ENTER_KEY !== key && 1 !== key.length) return;
  const event = new KeyboardEvent('keypress', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    repeat,
    ...mods,
  });
  // A real keypress carries the character code in all three legacy fields, and scanner handlers read
  // them. The constructor leaves them at 0 in every engine, so they are set on the instance.
  const legacy = ENTER_KEY === key ? ENTER_CHAR_CODE : key.charCodeAt(0);
  for (const field of LEGACY_KEY_CODE_FIELDS) {
    Object.defineProperty(event, field, { value: legacy });
  }
  asSyntheticInput(() => el.dispatchEvent(event));
}

/** US-layout physical keys for punctuation, unshifted and shifted. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  '/': 'Slash',
  '?': 'Slash',
  '.': 'Period',
  '>': 'Period',
  ',': 'Comma',
  '<': 'Comma',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '`': 'Backquote',
  '~': 'Backquote',
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
};

/** A punctuation key named by its code (`Meta+Slash`): the character it types unshifted. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const ENTER_KEY = 'Enter';
/** The carriage return a browser reports as Enter's keypress code. */
const ENTER_CHAR_CODE = 13;
const LEGACY_KEY_CODE_FIELDS = ['keyCode', 'charCode', 'which'] as const;

/**
 * Named keys whose `code` equals their `key`. An allow-list rather than a shape test: `Zzz` looks
 * exactly like `Tab` to a regex, and inventing `code: "Zzz"` would be a confident fabrication.
 */
const KNOWN_NAMED_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

const NO_DOCUMENT_TO_PRESS = 'no document to press into';

/**
 * Where a document-key press lands when no element was named: the focused control, else the
 * document body, the way a real keystroke does. Body is "no focus" for `activeRef`, but it is
 * still the node a browser delivers an untargeted keydown to.
 */
export function focusedOrDocument(): HTMLElement {
  const active = document.activeElement;
  if (isHtmlElement(active) && document.body !== active) return active;
  if (isHtmlElement(document.body)) return document.body;
  const root = document.documentElement;
  if (isHtmlElement(root)) return root;
  throw new Error(NO_DOCUMENT_TO_PRESS);
}

/** Whether this press, with no locator, is a document key rather than a missing ref. */
export function isReflessDocumentPress(
  ref: string,
  action: string,
  args: Record<string, unknown>,
): boolean {
  return 0 === ref.length && isGlobalPress(args) && ActionType.PRESS === action;
}

/**
 * The keys a `press` holds down TOGETHER, innermost last.
 *
 * `modifiers` are FLAGS on one key event — they say "meta was down when K was pressed" and cannot
 * express a key that is itself held while others are struck. That is a real shape on the web: a
 * game control, a hold-to-delete key, a shortcut that only fires while two non-modifier keys are
 * down. `args.keys: ["Control", "k"]` presses each in order and releases them in REVERSE, which is
 * what a keyboard physically does and what an app's keyup bookkeeping expects.
 *
 * Empty unless the caller asked: a single `key` stays the one-key path, so nothing about the common
 * case changes.
 */
export function pressKeys(args: Record<string, unknown>): string[] {
  return pressKeysFromArgs(args);
}

/** How often a held key repeats. Browsers land near 30-35ms after the initial delay; this is that. */
const KEY_REPEAT_MS = 33;
/** The pause before auto-repeat starts, as a real keyboard has. */
const KEY_REPEAT_DELAY_MS = 500;

/**
 * The legacy `keyCode` a keyboard gives each named key. Read by a great many handlers still
 * (`if (e.keyCode === 13)`), and `KeyboardEvent`'s constructor cannot set it: a synthetic event
 * reads 0, so those handlers ignore it while the press reports success. TodoMVC is one.
 */
const LEGACY_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};
const SINGLE_ALNUM = /^[a-z0-9]$/i;

/** The keyCode a keyboard would report for `key`: named keys by table, a letter or digit by its upper-case code. */
export const legacyKeyCode = (key: string): number =>
  LEGACY_KEY_CODES[key] ?? (SINGLE_ALNUM.test(key) ? key.toUpperCase().charCodeAt(0) : 0);

/** A KeyboardEvent as a keyboard sends it, `keyCode` and `which` included. */
export function keyboardEvent(
  type: string,
  init: KeyboardEventInit & { key: string },
): KeyboardEvent {
  const event = new KeyboardEvent(type, init);
  const code = legacyKeyCode(init.key);
  for (const legacy of ['keyCode', 'which'] as const)
    Object.defineProperty(event, legacy, { get: () => code });
  return event;
}

/**
 * Hold one key down for `ms`, emitting the `repeat: true` keydowns a browser sends while it is held.
 *
 * The repeats are the point rather than decoration: an app that counts keydowns to drive a
 * press-and-hold progress bar sees nothing from a bare down/up pair, so a hold with no repeat
 * reports a gesture that visibly did not happen.
 */
export async function holdKey(
  el: ActionTarget,
  key: string,
  code: string,
  mods: ModifierFlags,
  ms: number,
): Promise<void> {
  const started = Date.now();
  if (ms > KEY_REPEAT_DELAY_MS) await sleep(KEY_REPEAT_DELAY_MS);
  while (Date.now() - started < ms) {
    const down = asSyntheticInput(() =>
      el.dispatchEvent(
        keyboardEvent('keydown', {
          key,
          code,
          bubbles: true,
          cancelable: true,
          repeat: true,
          ...mods,
        }),
      ),
    );
    if (down) dispatchKeypress(el, key, code, mods, true);
    await sleep(Math.min(KEY_REPEAT_MS, Math.max(0, ms - (Date.now() - started))));
  }
}

/**
 * Press several keys together and release them in reverse, optionally holding at full depth.
 *
 * A modifier NAMED IN `keys` sets its own flag for the rest of the sequence, which is what makes
 * `{ keys: ['Control', 'k'] }` reach a handler that checks `event.ctrlKey`. `mods` alone cannot:
 * it is the fixed set from `args.modifiers`, and the whole reason `keys` exists is the shape those
 * flags cannot express. Without this the Control keydown arrived, the `k` keydown followed, and the
 * `k` carried `ctrlKey: false` while the action reported success — a false negative in the
 * expensive direction, the same one #393 fixed for `modifiers`.
 *
 * The flag timing is the browser's own, read off a real Chromium rather than assumed: a modifier's
 * OWN keydown carries its flag already true, its OWN keyup carries it already false, and every
 * event in between carries the state as it stands. Setting the flag after the dispatch, or clearing
 * it after the release, would each put one event out by one step.
 */
export async function pressCombo(
  el: ActionTarget,
  keys: readonly string[],
  mods: ModifierFlags,
  holdMs: number,
): Promise<boolean> {
  // Starts as the caller's `args.modifiers` and grows as `keys` names modifiers, so the two
  // spellings compose: `{ modifiers: ['Shift'], keys: ['Control', 'k'] }` is a Shift+Ctrl+K.
  const held: ModifierFlags = { ...mods };
  const dispatch = (type: string, key: string): boolean => {
    const code = pressCode({}, key);
    return asSyntheticInput(() =>
      el.dispatchEvent(
        keyboardEvent(type, { key, code, bubbles: true, cancelable: true, ...held }),
      ),
    );
  };

  /*
   * How many times each flag has been pressed, so a flag clears only on its LAST release.
   *
   * Aliases make this necessary rather than tidy: `Control` and `Ctrl` are ONE flag, so
   * `{ keys: ['Control', 'k', 'Ctrl'] }` is that flag pressed twice. Releasing in reverse puts
   * `Ctrl` first, and clearing the flag there turned it off while `Control` was still down —
   * every event after it reporting `ctrlKey: false`, which is a state no keyboard produces and an
   * app's keyup bookkeeping reads as "the modifier came up". Counting presses and clearing at zero
   * is what a real keyboard's own state machine does.
   *
   * The count starts at the flags `args.modifiers` already turned on, and that is the same rule
   * rather than a special case. `modifiers` is the fixed set for the WHOLE press — nothing in this
   * function ever releases it — so a flag it named is held from before the first keydown and stays
   * held past the last keyup. Starting the count at zero made `{ modifiers: ['Shift'], keys:
   * ['Shift', 'Tab'] }` clear Shift at its own keyup, contradicting the argument that had just
   * declared it held for the gesture.
   */
  const presses = new Map<keyof ModifierFlags, number>();
  for (const flag of MODIFIER_FLAG_KEYS) {
    if (held[flag]) presses.set(flag, 1);
  }
  const pressFlag = (flag: keyof ModifierFlags): void => {
    presses.set(flag, (presses.get(flag) ?? 0) + 1);
    held[flag] = true;
  };
  const releaseFlag = (flag: keyof ModifierFlags): void => {
    const left = (presses.get(flag) ?? 1) - 1;
    presses.set(flag, left);
    if (left <= 0) held[flag] = false;
  };

  let prevented = false;
  for (const key of keys) {
    const flag = modifierFlagFor(key);
    if (flag !== undefined) pressFlag(flag);
    const ok = dispatch('keydown', key);
    if (!ok) prevented = true;
    if (ok) dispatchKeypress(el, key, pressCode({}, key), held);
    // The same default a single Escape gets: `keys: ["Escape"]` is the same key.
    closeModalOnEscape(el, key, ok);
  }
  if (holdMs > 0) await sleep(holdMs);
  for (const key of [...keys].reverse()) {
    const flag = modifierFlagFor(key);
    if (flag !== undefined) releaseFlag(flag);
    dispatch('keyup', key);
  }
  return prevented;
}
/**
 * Emulate Escape's close request on the innermost open modal dialog around the target.
 * Synthetic key events have no browser default action, so they do not close a dialog themselves.
 */
export function closeModalOnEscape(el: ActionTarget, key: string, keydownProceeded: boolean): void {
  if ('Escape' !== key || !keydownProceeded) return;
  for (
    let dialog = el.closest('dialog');
    null !== dialog;
    dialog = dialog.parentElement?.closest('dialog') ?? null
  ) {
    // A nested non-modal dialog does not hide its modal ancestor. Without `:modal`, do not guess.
    try {
      if (!dialog.open || !dialog.matches(':modal')) continue;
    } catch {
      return;
    }
    // requestClose dispatches cancel and respects preventDefault; older engines need the fallback.
    if ('function' === typeof dialog.requestClose) dialog.requestClose();
    else if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    return;
  }
}

/**
 * The default actions a browser takes for a key, done for a synthetic `press`.
 *
 * A synthetic key event has no default action. The browser does not activate a button on Enter,
 * submit a form on Enter in a field, click a button on Space, or move focus on Tab. So `press`
 * reached the app and nothing followed, and a correct app was verified `no` (#1519).
 *
 * Each default runs only where a browser runs it, and only when the app did not cancel the key, so
 * the app sees what a person's keyboard gives it. A `role="button"` element gets no default, as in a
 * browser: the app must handle that key itself.
 */
/** The space bar, as a browser reports it in `KeyboardEvent.key`. */
export const SPACE_KEY = ' ';
const ENTER = 'Enter';
const TAB = 'Tab';

/** Elements that a browser activates (clicks) on Enter. */
const ENTER_ACTIVATES =
  'button, a[href], area[href], summary, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"]';
/** Elements that a browser activates (clicks) on Space, on keyup. A link only scrolls the page. */
const SPACE_ACTIVATES =
  'button, summary, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], input[type="checkbox"], input[type="radio"]';
/** Single-line fields in which Enter submits the form (implicit submission). */
const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);
/** Candidates for Tab order. Each is then filtered: disabled, `tabindex="-1"`, hidden, inert. */
const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** Modifiers that make a key mean something else (a shortcut), so the plain default does not run. */
interface Held {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const shortcut = (held: Held): boolean => held.metaKey || held.ctrlKey || held.altKey;

/** The default of a keydown that the app did not cancel: Enter activates or submits, Tab moves. */
export function runKeydownDefault(el: Element, key: string, held: Held): void {
  if (shortcut(held)) {
    return;
  }
  if (ENTER === key && !held.shiftKey) {
    enterDefault(el);
    return;
  }
  if (TAB === key) {
    moveFocus(el, held.shiftKey ? -1 : 1);
  }
}

/** The default of a Space keyup whose keydown the app did not cancel: it activates the control. */
export function runKeyupDefault(el: Element, key: string, held: Held): void {
  if (SPACE_KEY !== key || shortcut(held) || held.shiftKey) {
    return;
  }
  if (el.matches(SPACE_ACTIVATES) && !isDisabled(el)) {
    (el as HTMLElement).click();
  }
}

function enterDefault(el: Element): void {
  if (el.matches(ENTER_ACTIVATES)) {
    if (!isDisabled(el)) {
      (el as HTMLElement).click();
    }
    return;
  }
  const type = 'input' === el.localName ? (el.getAttribute('type') ?? 'text').toLowerCase() : '';
  if (!IMPLICIT_SUBMIT_TYPES.has(type)) {
    return;
  }
  const form = (el as HTMLInputElement).form;
  // `requestSubmit` validates and fires `submit`, as an implicit submission does.
  form?.requestSubmit();
}

function isDisabled(el: Element): boolean {
  return el.matches(':disabled');
}

/** Whether Tab can land on this element. */
function tabbable(el: Element): boolean {
  if (isDisabled(el) || null !== el.closest('[inert], [hidden]')) {
    return false;
  }
  const html = el as HTMLElement;
  if (html.tabIndex < 0) {
    return false;
  }
  return 'hidden' !== (el as HTMLInputElement).type;
}

/**
 * Move focus to the next (or previous) element in Tab order: positive `tabindex` first, in order,
 * then the rest in document order. From an element outside that order, the next one after it in
 * the document. At either end, focus stays: the browser would leave the page.
 */
function moveFocus(from: Element, step: 1 | -1): void {
  const doc = from.ownerDocument;
  const all = [...doc.querySelectorAll(FOCUSABLE)].filter(tabbable) as HTMLElement[];
  const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  const order = [...positive, ...all.filter((el) => 0 === el.tabIndex)];
  let at = order.indexOf(from as HTMLElement);
  if (at < 0) {
    at = order.findIndex(
      (el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    at = at < 0 ? order.length : at - (1 === step ? 1 : 0);
  }
  order[at + step]?.focus();
}

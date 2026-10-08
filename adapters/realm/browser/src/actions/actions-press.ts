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
  return pressKeyFromArgs(args);
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
    return '';
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
  if ('Enter' !== key && 1 !== key.length) return;
  asSyntheticInput(() =>
    el.dispatchEvent(
      new KeyboardEvent('keypress', {
        key,
        code,
        bubbles: true,
        cancelable: true,
        repeat,
        ...mods,
      }),
    ),
  );
}

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

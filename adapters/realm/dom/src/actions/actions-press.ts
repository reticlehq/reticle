import { ActionType, isGlobalPress, pressKeyFromArgs } from '@reticlehq/core';
import { asSyntheticInput } from './synthetic/synthetic-input.js';
import { nativeSetTimeout } from '../timers/native/native-timers.js';

/** Native, so a page that patched setTimeout cannot stretch or stall a hold. */
const sleep = (ms: number): Promise<void> => new Promise((r) => nativeSetTimeout(r, ms));
import { isHtmlElement } from '../dom/realm.js';

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

/**
 * Modifier flags for a `press`, from `args.modifiers`: an array of Meta / Control / Shift / Alt
 * (case-insensitive, with the usual aliases). Without them a Cmd+K / Ctrl+Shift shortcut receives a
 * keydown with every modifier false, so the app's own `event.metaKey` check never matches and
 * nothing observable happens -- a false negative Reticle reports as no error. (#393)
 */
export function pressModifiers(args: Record<string, unknown>): {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
} {
  const raw = args['modifiers'];
  const names = Array.isArray(raw) ? raw.map((m) => asString(m).toLowerCase()) : [];
  const has = (...aliases: string[]): boolean => aliases.some((a) => names.includes(a));
  return {
    metaKey: has('meta', 'cmd', 'command', 'super', 'win'),
    ctrlKey: has('control', 'ctrl'),
    shiftKey: has('shift'),
    altKey: has('alt', 'option', 'opt'),
  };
}

/**
 * The PHYSICAL key identity — `event.code` — derived from the logical key.
 *
 * A real browser always sends both, and a meaningful class of library reads only `code`, because it
 * is the layout-independent one: dnd-kit's KeyboardSensor matches its activation and arrow keys on
 * it, and so does react-aria. We sent `key` alone, so those handlers simply never matched — the
 * event fired, the listener ran, the guard failed, and the action reported dispatched over an app
 * that did nothing. Reported from the field as a keyboard drag that could be neither started nor
 * steered.
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
  const raw = args['keys'];
  if (!Array.isArray(raw)) return [];
  return raw.map((k) => asString(k)).filter((k) => k.length > 0);
}

/** How often a held key repeats. Browsers land near 30-35ms after the initial delay; this is that. */
const KEY_REPEAT_MS = 33;
/** The pause before auto-repeat starts, as a real keyboard has. */
const KEY_REPEAT_DELAY_MS = 500;

/**
 * Hold one key down for `ms`, emitting the `repeat: true` keydowns a browser sends while it is held.
 *
 * The repeats are the point rather than decoration: an app that counts keydowns to drive a
 * press-and-hold progress bar sees nothing from a bare down/up pair, so a hold with no repeat
 * reports a gesture that visibly did not happen.
 */
export async function holdKey(
  el: HTMLElement,
  key: string,
  code: string,
  mods: Record<string, boolean>,
  ms: number,
): Promise<void> {
  const started = Date.now();
  if (ms > KEY_REPEAT_DELAY_MS) await sleep(KEY_REPEAT_DELAY_MS);
  while (Date.now() - started < ms) {
    asSyntheticInput(() =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code,
          bubbles: true,
          cancelable: true,
          repeat: true,
          ...mods,
        }),
      ),
    );
    await sleep(Math.min(KEY_REPEAT_MS, Math.max(0, ms - (Date.now() - started))));
  }
}

/** Press several keys together and release them in reverse, optionally holding at full depth. */
export async function pressCombo(
  el: HTMLElement,
  keys: readonly string[],
  mods: Record<string, boolean>,
  holdMs: number,
): Promise<boolean> {
  let prevented = false;
  for (const key of keys) {
    const code = pressCode({}, key);
    const ok = asSyntheticInput(() =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }),
      ),
    );
    if (!ok) prevented = true;
  }
  if (holdMs > 0) await sleep(holdMs);
  for (const key of [...keys].reverse()) {
    const code = pressCode({}, key);
    asSyntheticInput(() =>
      el.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, ...mods })),
    );
  }
  return prevented;
}

/**
 * Why an in-page zoom is refused. Exported so the server and the SDK say the identical sentence.
 */
export const ZOOM_NEEDS_REAL_BROWSER_MSG =
  'cannot zoom from inside the page — CSS zoom changes how it LOOKS without changing the layout ' +
  'viewport, visualViewport or media queries, so a layout that breaks at 200% would be reported as ' +
  'checked and passing. Drive a real browser (reticle drive <url>, or reticle_lease) and zoom there.';

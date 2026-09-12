import { ActionType, isGlobalPress, pressKeyFromArgs } from '@reticlehq/core';
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

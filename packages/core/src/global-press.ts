import { ActionType } from './constants.js';

/**
 * The key a `press` sends when neither `text` nor `key` was named.
 *
 * Enter is the historical default. It is also the one key that must NEVER be treated as a
 * document key without a locator: on a focused field inside a form it submits it.
 */
export const DEFAULT_PRESS_KEY = 'Enter';

/**
 * Keys a real user sends at the page, not at a control. Escape dismisses, Tab moves focus.
 * A press of one of these with no ref is valid; a press of Enter or a letter is not.
 */
export const GLOBAL_PRESS_KEYS = ['Escape', 'Tab'] as const;

const GLOBAL_PRESS_KEY_SET: ReadonlySet<string> = new Set(
  GLOBAL_PRESS_KEYS.map((k) => k.toLowerCase()),
);

/**
 * Which key a `press` is asking for.
 *
 * `text` FIRST, because that is what the tool description documents ("{ text } for type/press")
 * and therefore what agents send. `key` still works — it is what anyone reading the source would
 * have sent — and the default only applies when neither was named.
 */
export function pressKeyFromArgs(args: Record<string, unknown>): string {
  const text = args['text'];
  if ('string' === typeof text && 0 < text.length) return text;
  const key = args['key'];
  if ('string' === typeof key && 0 < key.length) return key;
  return DEFAULT_PRESS_KEY;
}

function hasModifiers(args: Record<string, unknown>): boolean {
  const raw = args['modifiers'];
  return Array.isArray(raw) && 0 < raw.length;
}

/**
 * A press that is a document key, not an element action: Escape, Tab, or any key with modifiers
 * (Cmd+K). Requiring a ref for these forced a snapshot just to name an element the keystroke is
 * not about.
 */
export function isGlobalPress(args: Record<string, unknown>): boolean {
  if (hasModifiers(args)) return true;
  return GLOBAL_PRESS_KEY_SET.has(pressKeyFromArgs(args).toLowerCase());
}

/**
 * The tool/step shape `{ action, args }` — a press of a document key, so no locator is required.
 */
export function isGlobalPressCall(args: Record<string, unknown>): boolean {
  if (ActionType.PRESS !== args['action']) return false;
  const inner = args['args'];
  const pressArgs =
    'object' === typeof inner && null !== inner ? (inner as Record<string, unknown>) : {};
  return isGlobalPress(pressArgs);
}

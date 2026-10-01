import { ActionType } from './constants/constants.js';

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

/**
 * The keys a `press` holds down TOGETHER, from `args.keys`. Empty for the ordinary one-key press.
 *
 * `modifiers` cannot express this: they are FLAGS on one event, so "Control held while k and then j
 * are struck" has no spelling there. Only the in-page dispatcher implements the sequence — it
 * presses these in order and releases them in reverse — so the server reads them through here to
 * route such a press to that path rather than sending a chord it cannot spell.
 */
export function pressKeysFromArgs(args: Record<string, unknown>): string[] {
  const raw = args['keys'];
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const item of raw) {
    if ('string' === typeof item && 0 < item.length) keys.push(item);
  }
  return keys;
}

/** Canonical modifier names, in chord order — the spelling Playwright accepts. */
export const PRESS_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
export type PressModifier = (typeof PRESS_MODIFIERS)[number];

const MODIFIER_ALIASES: Readonly<Record<string, PressModifier>> = {
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  shift: 'Shift',
};

/**
 * Canonical, deduped modifiers in `PRESS_MODIFIERS` order; unknown names are dropped, since one the
 * driver cannot spell would change the whole chord. Server-side only — see `hasModifiers`.
 */
export function pressModifiersFromArgs(args: Record<string, unknown>): PressModifier[] {
  const raw = args['modifiers'];
  if (!Array.isArray(raw)) return [];
  const named = new Set<PressModifier>();
  for (const item of raw) {
    if ('string' !== typeof item) continue;
    const canonical = MODIFIER_ALIASES[item.toLowerCase()];
    if (canonical !== undefined) named.add(canonical);
  }
  return PRESS_MODIFIERS.filter((modifier) => named.has(modifier));
}

/**
 * Whether any modifier was named. Deliberately not via `pressModifiersFromArgs`: the alias table is
 * only referenced from there, so a page that never calls it does not carry the table — measured, by
 * splitting the table into its own module and watching the bundle stay byte-identical. The two
 * readings differ only for a name the alias table does not know, and that difference is inert here
 * — this answers "is a ref required", never which chord to send.
 */
function hasModifiers(args: Record<string, unknown>): boolean {
  const raw = args['modifiers'];
  return Array.isArray(raw) && 0 < raw.length;
}

/**
 * A press that is a document key, not an element action: Escape, Tab, any key with modifiers
 * (Cmd+K), or several keys held together. Requiring a ref for these forced a snapshot just to name
 * an element the keystroke is not about.
 *
 * `keys` counts even though `hasModifiers` cannot see it: a multi-key press is a sequence held at
 * the page, never aimed at one control, and without this the documented `keys` spelling would be
 * refused with "pass a ref" before anything could route it.
 *
 * A ONE-element `keys` is judged by the same rule as the one-key spelling rather than by its length:
 * it names the same key, so it owes the same answer. Counting the list instead let `{ keys: ["Enter"] }`
 * pass where `{ key: "Enter" }` is refused.
 */
export function isGlobalPress(args: Record<string, unknown>): boolean {
  if (hasModifiers(args)) return true;
  const keys = pressKeysFromArgs(args);
  // SEVERAL keys held together is a sequence at the page, never aimed at one control.
  if (1 < keys.length) return true;
  // ONE key in `keys` is the same press as naming it in `key`/`text`, so it must answer the same
  // question. Reading the list by LENGTH alone let `{ keys: ["Enter"] }` omit a ref, which the
  // one-key spelling refuses on purpose: Enter lands on whatever holds focus, and on a focused field
  // inside a form that submits it. The caller named a list, not a different key.
  if (1 === keys.length) {
    const only = keys[0];
    return only !== undefined && GLOBAL_PRESS_KEY_SET.has(only.toLowerCase());
  }
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

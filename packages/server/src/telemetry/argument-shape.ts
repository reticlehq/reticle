/**
 * Which flags and parameters people actually use — WITHOUT ever sending what they set them to.
 *
 * This is the most dangerous data in the product to collect, and the split that makes it safe is
 * NAMES versus VALUES:
 *
 *   - A flag or parameter NAME comes from a closed vocabulary we wrote ourselves. `--headed`,
 *     `--port`, `ref`, `timeout_ms` — there are a few dozen, none of them describe the user, and
 *     knowing which ones get used is the whole product question ("is anyone passing `fullPage`?
 *     does anybody use `--storage-state`?").
 *   - A VALUE is the user's. `--http-token` holds a secret. `--drive` holds a URL. `reticle_act`'s
 *     `args` holds the text being typed into the app, which on a login form is a password. A rule
 *     like "send short values, they're probably enums" would leak all three.
 *
 * So values are never sent, with one narrow exception: a handful of parameters whose values ARE our
 * own enums, listed explicitly below. `action: "click"` is our vocabulary, not the user's, and it
 * answers a real question. Membership in that list is opt-in per parameter and each entry names the
 * exact values allowed — anything outside the list is reported as `other`, so a schema change can
 * never quietly start forwarding free text.
 */

import { ActionType, FeedbackKind, QueryBy, SnapshotMode } from '@reticlehq/core';

/**
 * Parameters whose values are enums WE define, and the exact values allowed on the wire. An
 * unrecognized value reports `other` rather than itself; that fallback is what makes this safe
 * against a future where one of these params starts accepting free text.
 */
const SAFE_ENUM_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Every entry DERIVED from the enum core already owns, never hand-listed. The first version listed
  // them literally and was wrong on the day it shipped, not merely at risk: `action` was missing
  // `fill`, `dblclick`, `submit`, `scrollIntoView`, `drag` and `webmcp` — so `fill`, one of the most
  // common actions there is, silently reported as `other` — while carrying a `scroll` that
  // `ActionType` does not define. `mode` mixed SnapshotMode with unrelated session-lifecycle values.
  // Deriving is not tidiness here; it is the difference between the data being right and being wrong.
  ['action', new Set<string>(Object.values(ActionType))],
  ['by', new Set<string>(Object.values(QueryBy))],
  ['mode', new Set<string>(Object.values(SnapshotMode))],
  ['kind', new Set<string>(Object.values(FeedbackKind))],
  // `level` has no core enum — console levels come from the DOM console API, not from us. Listed
  // literally BECAUSE there is nothing to derive from, which is a different situation from the four
  // above and the reason it is called out rather than left looking like an oversight.
  ['level', new Set(['error', 'warn', 'info', 'log', 'debug'])],
]);

export const OTHER_VALUE = 'other';

/** True for anything we are willing to report a value for. */
export function isSafeEnumParam(name: string): boolean {
  return SAFE_ENUM_PARAMS.has(name);
}

/**
 * The reportable form of one parameter: `name` on its own, or `name:value` when the parameter is a
 * known enum. Never the raw value of anything else.
 */
export function describeParam(name: string, value: unknown): string {
  const allowed = SAFE_ENUM_PARAMS.get(name);
  if (allowed === undefined) return name;
  if (typeof value !== 'string') return name;
  return `${name}:${allowed.has(value) ? value : OTHER_VALUE}`;
}

/**
 * Parameters that carry no information about how the tool is USED, and so are not counted.
 *
 * `sessionId` is accepted by nearly every tool and passed on nearly every call, so counting it
 * produced a row per tool saying only "the agent addressed a session" — in one real day's export it
 * was a third of the toolParams block. This histogram exists to answer "is anyone using the argument
 * we shipped last release", and a parameter every call carries can never answer it.
 */
const UNINFORMATIVE_PARAMS: ReadonlySet<string> = new Set(['sessionId']);

/** Every parameter an agent actually passed to one tool call, reduced to names (+ safe enums). */
export function describeToolParams(args: Record<string, unknown>): string[] {
  return Object.keys(args)
    .filter((key) => args[key] !== undefined && !UNINFORMATIVE_PARAMS.has(key))
    .map((key) => describeParam(key, args[key]))
    .sort();
}

/**
 * The flags PRESENT on a CLI invocation, by name only.
 *
 * Values are dropped without exception here — no enum allowlist — because the CLI's flag values are
 * uniformly the user's: a port, a URL, a file path, a pairing token. `--http-token` alone is reason
 * enough to make this rule absolute rather than case-by-case.
 *
 * Anything not starting with `--` is an argument, not a flag, and is dropped entirely: that is where
 * the URL, the file list, and the feedback message live.
 */
export function describeCliFlags(argv: readonly string[]): string[] {
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    // `--port=9000` — split so the NAME is reported and the value is discarded with everything else.
    const name = arg.split('=')[0] ?? arg;
    flags.add(name);
  }
  return [...flags].sort();
}

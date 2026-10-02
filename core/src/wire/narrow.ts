/**
 * Reading a value off the wire without trusting it.
 *
 * Everything that arrives from a page, a config file or an agent's arguments is `unknown` until
 * something checks it. These are that check, in the smallest form: give me the string if it is a
 * string, and nothing if it is not.
 *
 * They lived under `tools/` in the server package, because a tool handler was the first thing that
 * needed them. Nothing about them is a tool: the rules that decide a verdict use them, the session
 * uses them, the command line uses them. A helper filed under where it was first needed rather than
 * what it does is a helper that drags its old neighbourhood along behind it, and this one was
 * dragging the whole tool surface into the verdict engine.
 *
 * `undefined` for a value of the wrong type, never a default. A number that arrives as the string
 * "12" is not a number, and quietly making it one is how a wire mistake becomes a wrong answer that
 * nothing reports.
 */

/** The value if it is a string, otherwise nothing. */
export function asString(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

/**
 * The value if it is a number, otherwise nothing.
 *
 * `NaN` and `Infinity` pass, because `typeof NaN` is `'number'`. That is worth knowing rather than
 * quietly fixing here: this moved out of the server unchanged, and tightening it in the same commit
 * would be a behaviour change wearing a refactor's message. If a caller needs a finite number it
 * should say so where it reads the value.
 */
export function asNumber(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

/**
 * The value if it is an object, otherwise an empty one.
 *
 * The odd one out: it answers with `{}` rather than `undefined`, because every caller is about to
 * read a key off it and an empty object gives them `undefined` for free.
 *
 * An ARRAY passes, because an array is an object to JavaScript. Almost certainly not what a caller
 * reaching for a named key meant, and left exactly as it was for the same reason as above: this is a
 * move, and a move that also changes behaviour is two changes wearing one message.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * How many bytes a string is, in every runtime the rules are meant to run in.
 *
 * `Buffer.byteLength` was used here and is a Node GLOBAL — it needs no import, so the guard that
 * polices `node:` imports never saw it, and it sat on a path this package exports from its front
 * door. An adopter running the rules in a browser, a worker, Deno or an edge runtime got a
 * ReferenceError out of code the package promises is standalone.
 *
 * `TextEncoder` is in all of them, and is WHATWG rather than Node. The encoder is created once:
 * this is called per event on the buffer's hot path, and allocating an encoder each time was the
 * only reason to prefer the global.
 */
const ENCODER = new TextEncoder();

export function byteSizeOf(text: string): number {
  return ENCODER.encode(text).length;
}

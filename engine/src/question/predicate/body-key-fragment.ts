/**
 * The one substring hit that cannot mean what the caller meant (#987).
 *
 * Reported from the field as the only false GREEN in that export: `net { bodyContains: "completed" }`
 * returned `verified: "yes"` for a job whose status was `queued`, because the body carried
 * `"completedAt": null` and `completed` is a substring of that KEY.
 *
 * `bodyContains` is a substring test and stays one — "this field is in the response"
 * (`bodyContains: "grand_total"`) and "this value came back" (`bodyContains: '"refunded":11.87'`)
 * are both real assertions people have saved, and neither is expressible if the field starts
 * demanding boundaries. What is detectable without touching that meaning is the single shape where
 * the hit can support NO reading at all: the needle appears only INSIDE a key name, matches no key
 * whole, and appears in no value anywhere in the document. Nobody asserts a fragment of a key — if
 * you mean the key you write the key, and if you mean a value it is not there.
 *
 * So this decides nothing on its own. It only separates "true and meaningless" from a pass.
 */

/** Every key and every leaf value in a parsed JSON document, as text. */
function collect(node: unknown, keys: string[], values: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keys, values);
    return;
  }
  if (null !== node && 'object' === typeof node) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      keys.push(key);
      collect(value, keys, values);
    }
    return;
  }
  values.push('string' === typeof node ? node : String(node));
}

/**
 * The key name a needle was found inside, when that is the ONLY place it occurs.
 *
 * `undefined` for every other case — a body that is not JSON (nothing here can tell a key from a
 * word), a needle that matches a key exactly, a needle that appears in any value, and a needle that
 * spans a key and its value, which belongs to neither half alone and is a value assertion.
 */
export function keyFragmentOnly(body: string, needle: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  const keys: string[] = [];
  const values: string[] = [];
  collect(payload, keys, values);
  if (keys.includes(needle)) return undefined;
  if (values.some((value) => value.includes(needle))) return undefined;
  return keys.find((key) => key.includes(needle));
}

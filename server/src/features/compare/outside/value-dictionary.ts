/**
 * Values the app compares its fields with, read from the scripts it serves. No instrumentation:
 * the page HTML and its scripts are fetched the way a browser fetches them.
 *
 * In `values.route === "progress"` the field named route gets "progress". `switch (x.route)` cases
 * and `["a", "b"].includes(x.route)` give their literals the same way. An explorer that does not
 * know this never types the value, and the branch behind it (a conditional step, a special mode)
 * stays unseen. A field matches a name when its folded name equals the name, or ends with a name of
 * three or more characters.
 */

/** Values by folded name. */
export type ValueDictionary = ReadonlyMap<string, readonly string[]>;

/** The most script files read for one page. */
export const MAX_SCRIPTS = 40;
/** The most values kept for one name. */
const MAX_VALUES = 4;
/** The longest literal kept: a longer one is text, not a value a field is compared with. */
const MAX_LITERAL = 40;
/** A name this short matches only exactly: `id` must not match every field that ends in "id". */
const MIN_SUFFIX = 3;

const SCRIPT_SRC = /<script[^>]+src=["']([^"']+)["']/g;
/** A module path: a built chunk, or a source module a dev server serves, with an optional query. */
const CHUNK = /["'](\.{0,2}\/[\w./@-]+\.(?:m?js|jsx|tsx?)(?:\?[^"']*)?)["']/g;
/** Library code and the dev server's own client: they hold no comparison of the app's fields. */
const NOT_APP = /\/node_modules\/|^\/@/;
const NAME_THEN_LITERAL = /\.([A-Za-z_$][\w$]*)\s*[!=]==?\s*["']([^"'\\]{1,40})["']/g;
const LITERAL_THEN_NAME = /["']([^"'\\]{1,40})["']\s*[!=]==?\s*[\w$.]*\.([A-Za-z_$][\w$]*)\b/g;
/** `switch (x.name) { ... }`: the body, up to a bound, holds the cases. */
const SWITCH = /switch\s*\(\s*[\w$.]*\.([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,3000}?)\}/g;
const CASE = /case\s*["']([^"'\\]{1,40})["']\s*:/g;
/** `["a", "b"].includes(x.name)`. */
const INCLUDES =
  /\[((?:\s*["'][^"'\\]{1,40}["']\s*,?)+)\]\.includes\(\s*[\w$.]*\.([A-Za-z_$][\w$]*)\s*\)/g;
const QUOTED = /["']([^"'\\]{1,40})["']/g;

/** A name, lowercase, letters and digits only. */
export const foldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const scriptSources = (html: string): string[] =>
  [...html.matchAll(SCRIPT_SRC)].map((m) => m[1] ?? '').filter((src) => src.length > 0);

export const chunkImports = (js: string): string[] =>
  [...js.matchAll(CHUNK)]
    .map((m) => m[1] ?? '')
    .filter((src) => src.length > 0 && !NOT_APP.test(src));

/** `[name, literal]` for each comparison of a named value with a string literal, in source order. */
export function comparedLiterals(js: string): [string, string][] {
  const found: { at: number; pair: [string, string] }[] = [];
  for (const m of js.matchAll(NAME_THEN_LITERAL)) {
    found.push({ at: m.index, pair: [m[1] ?? '', m[2] ?? ''] });
  }
  for (const m of js.matchAll(LITERAL_THEN_NAME)) {
    found.push({ at: m.index, pair: [m[2] ?? '', m[1] ?? ''] });
  }
  for (const m of js.matchAll(SWITCH)) {
    for (const c of (m[2] ?? '').matchAll(CASE)) {
      found.push({ at: m.index + c.index, pair: [m[1] ?? '', c[1] ?? ''] });
    }
  }
  for (const m of js.matchAll(INCLUDES)) {
    for (const v of (m[1] ?? '').matchAll(QUOTED)) {
      found.push({ at: m.index + v.index, pair: [m[2] ?? '', v[1] ?? ''] });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.pair);
}

export function buildDictionary(pairs: readonly (readonly [string, string])[]): ValueDictionary {
  const out = new Map<string, string[]>();
  for (const [name, value] of pairs) {
    const key = foldName(name);
    const values = out.get(key) ?? [];
    if (
      key.length > 0 &&
      value.length > 0 &&
      value.length <= MAX_LITERAL &&
      !values.includes(value)
    ) {
      out.set(key, [...values, value].slice(0, MAX_VALUES));
    }
  }
  return out;
}

/** The values for a field with this name, or none. */
export function magicValues(dictionary: ValueDictionary, name: string): readonly string[] {
  const folded = foldName(name);
  if (0 === folded.length) {
    return [];
  }
  const exact = dictionary.get(folded);
  if (exact !== undefined) {
    return exact;
  }
  for (const [key, values] of dictionary) {
    if (key.length >= MIN_SUFFIX && folded.endsWith(key)) {
      return values;
    }
  }
  return [];
}

/** `src` as an absolute url against `base`, or `src` when it cannot be resolved. */
function resolve(src: string, base: string): string {
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

/**
 * Fetch the page and its scripts, following script src and imported chunks, up to `MAX_SCRIPTS`
 * files. `fetchText` answers undefined for a file it could not get; that file adds nothing.
 */
export async function harvestDictionary(
  pageUrl: string,
  fetchText: (url: string) => Promise<string | undefined>,
): Promise<ValueDictionary> {
  const html = (await fetchText(pageUrl)) ?? '';
  const queue = scriptSources(html).map((src) => resolve(src, pageUrl));
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  while (queue.length > 0 && seen.size < MAX_SCRIPTS) {
    const url = queue.shift() ?? '';
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    const js = (await fetchText(url)) ?? '';
    queue.push(...chunkImports(js).map((src) => resolve(src, url)));
    pairs.push(...comparedLiterals(js));
  }
  return buildDictionary(pairs);
}

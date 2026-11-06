/**
 * Values the app compares its fields with, read from the scripts it serves. No instrumentation:
 * the page HTML and its scripts are fetched the way a browser fetches them.
 *
 * In `values.route === "progress"` the field named route gets "progress". `switch (x.route)` cases
 * and `["a", "b"].includes(x.route)` give their literals the same way. An explorer that does not
 * know this never types the value, and the branch behind it (a conditional step, a special mode)
 * stays unseen. A field matches a name when its folded name equals the name, or ends with a name of
 * three or more characters.
 *
 * The same scripts give the url parameters the page reads and the values it compares each with
 * (`urlParamValues`).
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
/**
 * `["a", "b"].includes(x.name)`. Each repeated item must end in a comma and the count is bounded, so
 * there is one way to match a list: an optional comma inside a repeated group backtracked exponentially
 * on a hostile script, and compare reads scripts from any page.
 */
const INCLUDES =
  /\[\s*((?:["'][^"'\\]{1,40}["']\s*,\s*){0,30}["'][^"'\\]{1,40}["'])\s*,?\s*\]\.includes\(\s*[\w$.]*\.([A-Za-z_$][\w$]*)\s*\)/g;
/**
 * What `typeof` returns. A `typeof x.name === "string"` check compares a type, not a value the app expects in
 * the field; bundled libraries are full of them, and they gave a field named Name the value "string".
 */
const TYPE_NAMES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'function',
  'undefined',
  'symbol',
  'bigint',
]);
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
  return found
    .filter((f) => !TYPE_NAMES.has(f.pair[1]))
    .sort((a, b) => a.at - b.at)
    .map((f) => f.pair);
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

/** `.get("name")`: a read of a url parameter when the code before it names the url. */
const PARAM_GET = /\.get\(\s*["']([A-Za-z_][\w-]{0,30})["']\s*\)/g;
const NEAR_URL = /URLSearchParams|searchParams|location/;
/** How far before a `.get(...)` the url must be named. */
const URL_BEFORE_CHARS = 200;
/** How far after a `.get(...)` the compared literals are read. Minified code renames the variable. */
const PARAM_AFTER_CHARS = 3000;
const PARAM_LITERAL =
  /[!=]==?\s*["']([\w-]{1,30})["']|["']([\w-]{1,30})["']\s*[!=]==|case\s*["']([\w-]{1,30})["']\s*:/g;

/**
 * `[parameter, literal]` for each url parameter the page reads, such as
 * `new URLSearchParams(location.search).get("scenario")`, with each literal compared in the code
 * after that read. A state behind the url (`?scenario=deferred`) is then a start page of its own.
 */
export function urlParamValues(js: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of js.matchAll(PARAM_GET)) {
    const before = js.slice(Math.max(0, m.index - URL_BEFORE_CHARS), m.index);
    if (!NEAR_URL.test(before)) {
      continue;
    }
    for (const v of js.slice(m.index, m.index + PARAM_AFTER_CHARS).matchAll(PARAM_LITERAL)) {
      out.push([m[1] ?? '', v[1] ?? v[2] ?? v[3] ?? '']);
    }
  }
  return out;
}

/** What the scripts of a page tell the plan. */
export interface ScriptHints {
  dictionary: ValueDictionary;
  /** The values each url parameter is compared with, in source order, each value once. */
  urlParams: ReadonlyMap<string, readonly string[]>;
}

/**
 * Fetch the page and its scripts, following script src and imported chunks, up to `MAX_SCRIPTS`
 * files. `fetchText` answers undefined for a file it could not get; that file adds nothing.
 */
export async function harvestScripts(
  pageUrl: string,
  fetchText: (url: string) => Promise<string | undefined>,
): Promise<ScriptHints> {
  const html = (await fetchText(pageUrl)) ?? '';
  const queue = scriptSources(html).map((src) => resolve(src, pageUrl));
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  const urlParams = new Map<string, string[]>();
  while (queue.length > 0 && seen.size < MAX_SCRIPTS) {
    const url = queue.shift() ?? '';
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    const js = (await fetchText(url)) ?? '';
    queue.push(...chunkImports(js).map((src) => resolve(src, url)));
    pairs.push(...comparedLiterals(js));
    for (const [param, value] of urlParamValues(js)) {
      const values = urlParams.get(param) ?? [];
      if (!values.includes(value)) {
        urlParams.set(param, [...values, value]);
      }
    }
  }
  return { dictionary: buildDictionary(pairs), urlParams };
}

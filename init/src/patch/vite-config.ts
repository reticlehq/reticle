/**
 * Pure, conservative patcher for a Vite config: add the `@reticlehq/vite-plugin` import and drop
 * `reticle` into the `plugins` array. Only handles the obvious, common shape — anything ambiguous
 * bails to a `manual` result so we never half-edit a build config (a broken config is worse than a
 * documented manual step).
 */

import { braceDepth, maskStringsAndComments, matchingBraceEnd } from './brace-scan.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

export const VITE_IMPORT = "import { reticle } from '@reticlehq/vite-plugin';";
const RETICLE_MARKER = '@reticlehq/vite-plugin';

/**
 * The `reticle(...)` call — the bridge port so the injected connect targets it.
 *
 * **`captureNetworkBodies` is OPT-IN.**
 *
 * The case FOR capturing bodies is real: without one, a write that answers 2xx grades
 * `unknown / outcome_unread`, because a 200 describes the transport and not the result. A request
 * that posts a wrong amount can answer 200, render the amount the user typed, and pass every
 * DOM-level check.
 *
 * That justifies the CAPABILITY, not the default. Any app proxying authenticated API traffic through
 * Vite puts request bodies in the daemon's buffer on the first drive, and the credential classes are
 * redacted while an address or an email is not. Writing the line into someone's config IS deciding
 * that for them — and `init` is run unattended by an agent, so the person who knows whether the data
 * is sensitive is not in the room.
 *
 * So the default is off and the ways in are all deliberate:
 *   - `reticle init --capture-bodies` writes the line, for someone who has decided
 *   - `VITE_RETICLE_CAPTURE_BODIES=1` turns it on for ONE dev-server run, no config edit
 *   - adding the option by hand, which is what the tools tell you to do
 *
 * Nothing goes quiet in exchange. Every tool that needs a body already says so when it is missing
 * and names the option — see honesty/uncaptured-bodies.ts, honesty/verified.ts, predicate-eval.ts
 * and reconcile-tools.ts — so the capability is discovered at the moment it is wanted, by the person
 * who wanted it, instead of being switched on before anyone has asked.
 */
function reticlePluginCall(opts: PluginCallOptions): string {
  const options = [
    ...(opts.port === undefined ? [] : [`port: ${String(opts.port)}`]),
    ...(false === opts.inject ? ['inject: false'] : []),
    ...(opts.captureBodies ? ['captureNetworkBodies: true'] : []),
    ...(opts.sourceMapping ? [] : ['sourceMapping: false']),
  ];
  return 0 === options.length ? 'reticle()' : `reticle({ ${options.join(', ')} })`;
}

/**
 * What `init` decided to write into the call. Grouped rather than threaded positionally: two
 * adjacent booleans through three helpers is a swap waiting to happen, and the swap is silent.
 */
interface PluginCallOptions {
  port: number | undefined;
  captureBodies: boolean;
  /**
   * Let the plugin inject `connect()` into `index.html`. False for a framework that SSRs its own
   * document and never serves Vite's — TanStack Start, Remix — where only the injection half is
   * inapplicable and the stamping half still earns its place.
   */
  inject: boolean;
  /**
   * Stamp `data-reticle-source`. Written as `sourceMapping: false` for an app whose React renderer
   * is not React DOM — see `Detection.customReconciler`, where the whole argument lives. The plugin
   * defaults it ON, so the only way to spare such an app is to say so in the config.
   */
  sourceMapping: boolean;
}
/** A `plugins:` key, up to the start of its value. */
const PLUGINS_KEY_COLON = /\bplugins\s*:\s*/g;
/**
 * The start of a plugin list we can extend, read at the start of the key's value: a plain array
 * literal, or the same array returned by Vite+'s `lazyPlugins(() => [...])`.
 *
 * `vp migrate` and `vp create` wrap the app's plugins in `lazyPlugins`, so Vite+ can read the lint
 * and format blocks without loading every plugin. The list inside is still the app's plugin list,
 * and Vite loads it for `vp dev`. Without this form, init left a migrated Laravel app as a manual
 * step (#2134).
 */
const PLUGIN_LIST_START = /^(?:lazyPlugins\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*)?\[/;
/**
 * The shorthand `{ plugins }` key. When it holds, the key is there but not as an array literal, so
 * adding our own key would make a second one. The later key wins, and one of the two lists is lost.
 */
const PLUGINS_SHORTHAND = /\bplugins\s*[,}]/;
/** Matches an ES import statement (used to place our import after the last one). */
const IMPORT_LINE = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;
/**
 * The opening `{` of the exported config object — `defineConfig({`, or a bare `export default {`.
 * Used only when there is no `plugins` array to extend: the object is right there, so adding the
 * key is the same edit as extending the array, and bailing sent a user whose config merely set
 * `server.port` to a manual paste for a change we can make correctly.
 *
 * A config built by a call (`defineConfig(buildOptions())`) has no literal to extend and still
 * bails — the rule stays "only edit a shape we can see whole".
 */
const CONFIG_OBJECT = /(export\s+default\s+(?:defineConfig\s*\(\s*)?)\{/;
/** Where the default export starts, for a config that is not an object literal. */
const EXPORT_DEFAULT = /\bexport\s+default\b/;

/** Alias kept so existing call sites read in Vite terms; the vocabulary is shared (see patch-kind). */
export const VitePatchKind = PatchKind;
export type VitePatchKind = PatchKind;

type VitePatch = SourcePatch;

const UNREADABLE_REASON =
  'init could not read this config safely (a string, comment or regex that it could not follow), ' +
  'so it did not change it. Add `reticle()` to the `plugins` list of the exported config.';
const NO_PLUGINS_REASON = "couldn't find a `plugins: [...]` array to extend";
const AMBIGUOUS_PLUGINS_REASON =
  'the config function builds more than one `plugins` list at the same level, so init did not ' +
  'pick one. Add `reticle()` to the `plugins` list of the config that the function returns.';
const PLUGINS_NOT_ARRAY_REASON =
  'the `plugins` key is not an array literal, so init did not change it. Add `reticle()` to the ' +
  'list that the key builds. Do not add a second `plugins` key: the later key replaces the first.';

function insertImport(source: string): string {
  const matches = [...source.matchAll(IMPORT_LINE)];
  const last = matches[matches.length - 1];
  if (last?.index === undefined) {
    return `${VITE_IMPORT}\n${source}`;
  }
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${VITE_IMPORT}${source.slice(end)}`;
}

/**
 * Insert right after the opening `[` of the plugins array, spaced the way the surrounding line is.
 *
 * A multi-line array puts a newline next, and `[reticle(), \n` leaves trailing whitespace — exactly
 * what a formatter rewrites, turning a one-line install into a diff against the user's own style. A
 * single-line array needs the space, or the result reads `[reticle(),react()]`.
 */
function insertPlugin(source: string, call: string, at: number): string {
  const next = source[at] ?? '';
  const separator = '' === next || /\s/.test(next) ? '' : ' ';
  return `${source.slice(0, at)}${call},${separator}${source.slice(at)}`;
}

/** No single `plugins` key can be told to be the config's own: two lists compete for it. */
const AMBIGUOUS = 'ambiguous';

/**
 * Where the value of the config's OWN `plugins` key starts, undefined when the config has none, or
 * AMBIGUOUS when two lists compete and nothing says which one Vite reads.
 *
 * Other blocks can hold a `plugins` key too: Vite+'s `lint.plugins` names oxlint plugins, and
 * `worker.plugins` and `build.rollupOptions.plugins` are other bundlers' lists. The first match in
 * the file used to win. On a `vp create` React app that is `lint.plugins`, so init wrote
 * `reticle()` into the lint settings, reported the step done, and the app never connected (#2134).
 *
 * So when the exported object is a literal we can see, only a key at that literal's own level, inside
 * it, is its key. A config written as a function is read by `functionConfigPluginsAt`.
 */
function vitePluginsValueAt(source: string): number | typeof AMBIGUOUS | undefined {
  const literal = exportedLiteralStart(source);
  if (literal !== undefined) {
    // The literal is in view, so only its own keys count. A key outside it is another object's: a
    // hoisted `const lint = { plugins: [...] }` that the config names by shorthand.
    return ownPluginsKeyAt(source, literal);
  }
  return functionConfigPluginsAt(source, exportedRegion(source));
}

/** Where the value of the `plugins` key of the object literal whose inner start is `literal` begins. */
function ownPluginsKeyAt(source: string, literal: number): number | undefined {
  const end = matchingBraceEnd(source, literal) ?? source.length;
  const depth = braceDepth(source, literal);
  for (const match of source.matchAll(PLUGINS_KEY_COLON)) {
    if (match.index > literal && match.index < end && depth === braceDepth(source, match.index)) {
      return match.index + match[0].length;
    }
  }
  return undefined;
}

/** An object literal a config function gives back: `return {` or an arrow's `=> ({`. */
const RETURNED_OBJECT = /\breturn\s*\(?\s*\{|=>\s*\(\s*\{/g;

/**
 * The `plugins` value of a config built by a function (`defineConfig(({ mode }) => { ... })`).
 *
 * The config is the object the function returns. A body can build other objects with a `plugins`
 * key first (`const x = { plugins: [legacy()] }`), at the same depth as the returned one, and the
 * key that came first used to win. So the returned object literals are read first: one with its own
 * `plugins` key is the config's list, and two (a config per mode) are AMBIGUOUS. A returned object
 * inside another one is that object's value, such as an inline plugin's hook, and does not count.
 *
 * A function that returns a name (`return config`) or a call has no literal to read, and a returned
 * literal may take its list from a spread (`...shared`). Then the key with the fewest open braces in
 * the exported expression wins, and a tie is AMBIGUOUS. A
 * const declared above the export (`const lint = { plugins: [...] }`) is never in that region.
 */
function functionConfigPluginsAt(
  source: string,
  region: { from: number; to: number },
): number | typeof AMBIGUOUS | undefined {
  const returned: { start: number; end: number }[] = [];
  for (const match of source.matchAll(RETURNED_OBJECT)) {
    const start = match.index + match[0].length;
    if (match.index < region.from || match.index >= region.to) {
      continue;
    }
    if (returned.some((outer) => start > outer.start && start <= outer.end)) {
      continue;
    }
    returned.push({ start, end: matchingBraceEnd(source, start) ?? source.length });
  }
  const keys = returned
    .map((object) => ownPluginsKeyAt(source, object.start))
    .filter((at): at is number => at !== undefined);
  if (1 < keys.length) {
    return AMBIGUOUS;
  }
  if (1 === keys.length) {
    return keys[0];
  }
  // A returned literal with no `plugins` key of its own is the whole config, and it has no list:
  // a `plugins` key elsewhere in the body is another object's. Only a spread (`...shared`) can
  // bring one in, and then the body's own keys are all there is to go on.
  if (
    0 < returned.length &&
    !returned.some((object) => source.slice(object.start, object.end).includes('...'))
  ) {
    return undefined;
  }
  let best: { depth: number; valueAt: number; tied: boolean } | undefined;
  for (const match of source.matchAll(PLUGINS_KEY_COLON)) {
    if (match.index < region.from || match.index >= region.to) {
      continue;
    }
    const depth = braceDepth(source, match.index);
    if (best === undefined || depth < best.depth) {
      best = { depth, valueAt: match.index + match[0].length, tied: false };
    } else if (depth === best.depth) {
      best.tied = true;
    }
  }
  if (best !== undefined && best.tied) {
    return AMBIGUOUS;
  }
  return best?.valueAt;
}

/** The name a default export refers to: `export default config` or `export default defineConfig(config)`. */
const EXPORTED_NAME =
  /\bexport\s+default\s+(?:defineConfig\s*\(\s*)?([A-Za-z_$][\w$]*)\s*(?:[;)]|$)/m;

/** Where `const|let|var <name> =` declares the name the default export refers to, if it does. */
function exportedDeclaration(source: string): RegExpExecArray | null {
  const name = EXPORTED_NAME.exec(source)?.[1];
  if (name === undefined) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]*)?=\\s*(?:defineConfig\\s*\\(\\s*)?`,
  ).exec(source);
}

/**
 * The index just past the `{` of the exported config object literal: written in the export itself,
 * or in the declaration of the name it exports (`const config = defineConfig({...})`).
 */
function exportedLiteralStart(source: string): number | undefined {
  const inline = CONFIG_OBJECT.exec(source);
  if (null !== inline) {
    return inline.index + inline[0].length;
  }
  const declared = exportedDeclaration(source);
  if (null !== declared && '{' === source[declared.index + declared[0].length]) {
    return declared.index + declared[0].length + 1;
  }
  return undefined;
}

/**
 * The part of the file that holds the exported config: from the declaration of the name it exports
 * up to the export, or from the export to the end of the file.
 */
function exportedRegion(source: string): { from: number; to: number } {
  const exported = EXPORT_DEFAULT.exec(source)?.index;
  const declared = exportedDeclaration(source)?.index;
  if (declared !== undefined && exported !== undefined && declared < exported) {
    return { from: declared, to: exported };
  }
  return { from: exported ?? 0, to: source.length };
}

/**
 * Add a whole `plugins: [reticle()]` key to a config object that has none, matching the layout of
 * the object it lands in: a multi-line object gets its own indented line, a one-liner stays inline.
 */
function insertPluginsKey(source: string, call: string): string {
  return source.replace(CONFIG_OBJECT, (_match, prefix: string, offset: number) => {
    const rest = source.slice(offset + _match.length);
    const multiline = /^\s*\n/.test(rest);
    const indent = /^\s*\n(\s*)\S/.exec(rest)?.[1] ?? '  ';
    const key = `plugins: [${call}],`;
    return multiline ? `${prefix}{\n${indent}${key}` : `${prefix}{ ${key}`;
  });
}

/**
 * The package a new config imports `defineConfig` from.
 *
 * A Vite+ app imports it from `vite-plus`. Under pnpm it may not declare `vite` at all, so an
 * import from `vite` would not resolve, and Vite+'s own lint rule refuses it.
 */
export const DefineConfigSource = {
  VITE: 'vite',
  VITE_PLUS: 'vite-plus',
} as const;
export type DefineConfigSource = (typeof DefineConfigSource)[keyof typeof DefineConfigSource];

/**
 * A whole config for a plain Vite app that has none: Vite's defaults plus the plugin. Written out
 * rather than patched from an empty one, because it is a file the person will open and read.
 */
export function newViteConfig(
  port?: number,
  captureBodies = false,
  inject = true,
  sourceMapping = true,
  defineConfigFrom: DefineConfigSource = DefineConfigSource.VITE,
): string {
  const call = reticlePluginCall({ port, captureBodies, inject, sourceMapping });
  return `import { defineConfig } from '${defineConfigFrom}';\n${VITE_IMPORT}\n\nexport default defineConfig({\n  plugins: [${call}],\n});\n`;
}

export function patchViteConfig(
  source: string,
  port?: number,
  captureBodies = false,
  inject = true,
  sourceMapping = true,
): VitePatch {
  if (source.includes(RETICLE_MARKER)) {
    return { kind: VitePatchKind.ALREADY };
  }
  const call = reticlePluginCall({ port, captureBodies, inject, sourceMapping });
  const masked = maskStringsAndComments(source);
  if (null === masked) {
    return { kind: VitePatchKind.MANUAL, reason: UNREADABLE_REASON };
  }
  const valueAt = vitePluginsValueAt(masked);
  if (AMBIGUOUS === valueAt) {
    return { kind: VitePatchKind.MANUAL, reason: AMBIGUOUS_PLUGINS_REASON };
  }
  if (valueAt !== undefined) {
    const list = PLUGIN_LIST_START.exec(source.slice(valueAt));
    if (null === list) {
      return { kind: VitePatchKind.MANUAL, reason: PLUGINS_NOT_ARRAY_REASON };
    }
    const code = insertPlugin(source, call, valueAt + list[0].length);
    return { kind: VitePatchKind.APPLY, code: insertImport(code) };
  }
  if (PLUGINS_SHORTHAND.test(masked)) {
    return { kind: VitePatchKind.MANUAL, reason: PLUGINS_NOT_ARRAY_REASON };
  }
  if (CONFIG_OBJECT.test(source)) {
    return { kind: VitePatchKind.APPLY, code: insertImport(insertPluginsKey(source, call)) };
  }
  return { kind: VitePatchKind.MANUAL, reason: NO_PLUGINS_REASON };
}

/**
 * Pure, conservative patcher for a Vite config: add the `@reticlehq/vite-plugin` import and drop
 * `reticle` into the `plugins` array. Only handles the obvious, common shape — anything ambiguous
 * bails to a `manual` result so we never half-edit a build config (a broken config is worse than a
 * documented manual step).
 */

import { matchingBraceEnd } from './brace-scan.js';
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

/**
 * The source with every string literal, regex literal and comment blanked to spaces, newlines kept,
 * so each index still points at the same place in the real source. Null when the scan does not end
 * cleanly: a string, comment or regex that never closes, or braces that do not balance.
 *
 * The key search below counts braces. A `{` inside a string, or a `plugins: [` in a comment, used to
 * move that count, and init then added a second `plugins` key whose list Vite never reads. A source
 * this scan cannot read is a manual step, never a guess.
 */
function maskStringsAndComments(source: string): string | null {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if ('\n' !== out[k]) {
        out[k] = ' ';
      }
    }
  };
  /** The last character before `at` that is not whitespace, in the masked output so far. */
  const previousToken = (at: number): string => {
    for (let k = at - 1; k >= 0; k -= 1) {
      const c = out[k] ?? '';
      if (!/\s/.test(c)) {
        return c;
      }
    }
    return '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    let stop: number | null;
    if ('/' === ch && '/' === next) {
      const end = source.indexOf('\n', i);
      stop = -1 === end ? source.length : end;
    } else if ('/' === ch && '*' === next) {
      const end = source.indexOf('*/', i + 2);
      stop = -1 === end ? null : end + 2;
    } else if ("'" === ch || '"' === ch || '`' === ch) {
      stop = closingQuote(source, i, ch);
    } else if ('/' === ch && REGEX_MAY_FOLLOW.includes(previousToken(i))) {
      stop = closingRegex(source, i);
    } else {
      i += 1;
      continue;
    }
    if (null === stop) {
      return null;
    }
    blank(i, stop);
    i = stop;
  }
  const masked = out.join('');
  return 0 === braceDepth(masked, masked.length) ? masked : null;
}

/** Where a `/` starts a regex literal rather than a division: after one of these, or at the start. */
const REGEX_MAY_FOLLOW = ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'];

/** The index just past the quote that closes the string opened at `at`, or null. */
function closingQuote(source: string, at: number, quote: string): number | null {
  let j = at + 1;
  while (j < source.length) {
    const c = source[j];
    if ('\\' === c) {
      j += 2;
    } else if (quote === c) {
      return j + 1;
    } else if ('\n' === c && '`' !== quote) {
      return null;
    } else {
      j += 1;
    }
  }
  return null;
}

/** The index just past the flags of the regex literal opened at `at`, or null. */
function closingRegex(source: string, at: number): number | null {
  let j = at + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if ('\\' === c) {
      j += 2;
      continue;
    }
    if ('\n' === c) {
      return null;
    }
    if ('[' === c) {
      inClass = true;
    } else if (']' === c) {
      inClass = false;
    } else if ('/' === c && !inClass) {
      j += 1;
      while (j < source.length && /[a-z]/i.test(source[j] ?? '')) {
        j += 1;
      }
      return j;
    }
    j += 1;
  }
  return null;
}

/** How many `{` are open at `index`. A count, not a parser: see brace-scan.ts for its limits. */
function braceDepth(source: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if ('{' === source[i]) {
      depth += 1;
    } else if ('}' === source[i]) {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * Where the value of the config's OWN `plugins` key starts, or undefined when the config has none.
 *
 * Other blocks can hold a `plugins` key too: Vite+'s `lint.plugins` names oxlint plugins, and
 * `worker.plugins` and `build.rollupOptions.plugins` are other bundlers' lists. The first match in
 * the file used to win. On a `vp create` React app that is `lint.plugins`, so init wrote
 * `reticle()` into the lint settings, reported the step done, and the app never connected (#2134).
 *
 * So when the exported object is a literal we can see, only a key at that literal's own level, inside
 * it, is its key. Without a literal (a config written as a function), the key with the fewest open
 * braces wins.
 */
function vitePluginsValueAt(source: string): number | undefined {
  const literal = exportedLiteralStart(source);
  if (literal !== undefined) {
    // The literal is in view, so only its own keys count. A key outside it is another object's: a
    // hoisted `const lint = { plugins: [...] }` that the config names by shorthand.
    const end = matchingBraceEnd(source, literal) ?? source.length;
    const depth = braceDepth(source, literal);
    for (const match of source.matchAll(PLUGINS_KEY_COLON)) {
      if (match.index > literal && match.index < end && depth === braceDepth(source, match.index)) {
        return match.index + match[0].length;
      }
    }
    return undefined;
  }
  // A config built by a function. Only a key in the exported expression can be its own: a const
  // declared above it (`const lint = { plugins: [...] }`) is another object, whatever its depth.
  const { from, to } = exportedRegion(source);
  let best: { depth: number; valueAt: number } | undefined;
  for (const match of source.matchAll(PLUGINS_KEY_COLON)) {
    if (match.index < from || match.index >= to) {
      continue;
    }
    const depth = braceDepth(source, match.index);
    if (best === undefined || depth < best.depth) {
      best = { depth, valueAt: match.index + match[0].length };
    }
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

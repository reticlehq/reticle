/**
 * Pure, conservative patcher for a Vite config: add the `@reticlehq/vite-plugin` import and drop
 * `reticle` into the `plugins` array. Only handles the obvious, common shape — anything ambiguous
 * bails to a `manual` result so we never half-edit a build config (a broken config is worse than a
 * documented manual step).
 */

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
/** Matches the start of a `plugins: [` array literal. */
const PLUGINS_ARRAY = /plugins\s*:\s*\[/;
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

/** Alias kept so existing call sites read in Vite terms; the vocabulary is shared (see patch-kind). */
export const VitePatchKind = PatchKind;
export type VitePatchKind = PatchKind;

type VitePatch = SourcePatch;

const NO_PLUGINS_REASON = "couldn't find a `plugins: [...]` array to extend";

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
function insertPlugin(source: string, call: string): string {
  // `(match, offset, source)` — PLUGINS_ARRAY has no capture group. Reading the second argument as
  // one put the whole source string in `offset`, so the index below was `undefined` and the
  // separator was empty every single time.
  return source.replace(PLUGINS_ARRAY, (match: string, offset: number) => {
    const next = source[offset + match.length] ?? '';
    const separator = '' === next || /\s/.test(next) ? '' : ' ';
    return `${match}${call},${separator}`;
  });
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
 * A whole config for a plain Vite app that has none: Vite's defaults plus the plugin. Written out
 * rather than patched from an empty one, because it is a file the person will open and read.
 */
export function newViteConfig(
  port?: number,
  captureBodies = false,
  inject = true,
  sourceMapping = true,
): string {
  const call = reticlePluginCall({ port, captureBodies, inject, sourceMapping });
  return `import { defineConfig } from 'vite';\n${VITE_IMPORT}\n\nexport default defineConfig({\n  plugins: [${call}],\n});\n`;
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
  if (PLUGINS_ARRAY.test(source)) {
    return { kind: VitePatchKind.APPLY, code: insertImport(insertPlugin(source, call)) };
  }
  if (CONFIG_OBJECT.test(source)) {
    return { kind: VitePatchKind.APPLY, code: insertImport(insertPluginsKey(source, call)) };
  }
  return { kind: VitePatchKind.MANUAL, reason: NO_PLUGINS_REASON };
}

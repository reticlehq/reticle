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
 * The `reticle(...)` call — the bridge port so the injected connect targets it, and body capture.
 *
 * `captureNetworkBodies` is here rather than in the SDK's defaults, deliberately. Without it a write
 * that answers 2xx with a body nobody recorded grades `unknown / outcome_unread`, because a 200
 * describes the transport and not the result — so the single bug class this product exists to catch is
 * unreachable on a default install. Measured on a real payments UI: a refund posted rupees into a
 * paise field, the server answered 200 having refunded a hundredth of it, the page rendered the amount
 * the user had typed rather than the amount that came back, and every DOM-level check passed. An agent
 * asked to verify that flow had to edit the app's own vite config mid-task to see the payload, and
 * then tell its human to undo the edit.
 *
 * Written into the USER'S config, not switched on inside the SDK, and the difference is the point. A
 * body is the one part of a request that routinely carries personal data: the credential classes are
 * redacted before anything is journalled — tokens, cookies, card numbers, cvv, ssn — but an address or
 * an email is not, and nothing here should decide that for someone silently. In the config it is one
 * visible line they can read, keep, or delete, and an SDK that updates underneath them never starts
 * recording more than it did yesterday.
 */
function reticlePluginCall(port: number | undefined): string {
  const options = [
    ...(port === undefined ? [] : [`port: ${String(port)}`]),
    'captureNetworkBodies: true',
  ];
  return `reticle({ ${options.join(', ')} })`;
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
function insertPlugin(source: string, port: number | undefined): string {
  return source.replace(PLUGINS_ARRAY, (match, _g, offset: number) => {
    const next = source[offset + match.length] ?? '';
    const separator = '' === next || /\s/.test(next) ? '' : ' ';
    return `${match}${reticlePluginCall(port)},${separator}`;
  });
}

/**
 * Add a whole `plugins: [reticle()]` key to a config object that has none, matching the layout of
 * the object it lands in: a multi-line object gets its own indented line, a one-liner stays inline.
 */
function insertPluginsKey(source: string, port: number | undefined): string {
  return source.replace(CONFIG_OBJECT, (_match, prefix: string, offset: number) => {
    const rest = source.slice(offset + _match.length);
    const multiline = /^\s*\n/.test(rest);
    const indent = /^\s*\n(\s*)\S/.exec(rest)?.[1] ?? '  ';
    const key = `plugins: [${reticlePluginCall(port)}],`;
    return multiline ? `${prefix}{\n${indent}${key}` : `${prefix}{ ${key}`;
  });
}

export function patchViteConfig(source: string, port?: number): VitePatch {
  if (source.includes(RETICLE_MARKER)) {
    return { kind: VitePatchKind.ALREADY };
  }
  if (PLUGINS_ARRAY.test(source)) {
    return { kind: VitePatchKind.APPLY, code: insertImport(insertPlugin(source, port)) };
  }
  if (CONFIG_OBJECT.test(source)) {
    return { kind: VitePatchKind.APPLY, code: insertImport(insertPluginsKey(source, port)) };
  }
  return { kind: VitePatchKind.MANUAL, reason: NO_PLUGINS_REASON };
}

/**
 * Conservative patcher for an electron-vite config: add `@reticlehq/vite-plugin` and drop
 * `reticle({ desktop: true, ... })` into the RENDERER block's plugins array.
 *
 * A generic Vite patcher takes the first `plugins: [` in the file, which in a conventional
 * electron-vite config is `main`'s. Wiring the SDK into the main process installs it where there
 * is no document, and reports success — worse than today's honest refusal. This patcher finds the
 * `renderer` block specifically and refuses anything it cannot see whole.
 */

import { matchingBraceEnd } from './brace-scan.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

export const ELECTRON_VITE_IMPORT = "import { reticle } from '@reticlehq/vite-plugin';";
const RETICLE_MARKER = '@reticlehq/vite-plugin';
const RETICLE_CALL = /reticle\s*\(/;
const DESKTOP_FLAG = /desktop\s*:/;
const PLUGINS_ARRAY = /plugins\s*:\s*\[/;
const IMPORT_LINE = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;
const RENDERER_KEY = /renderer\s*:\s*/;

const NO_RENDERER_REASON = "couldn't find a `renderer` key to extend";
const RENDERER_NOT_LITERAL_REASON =
  'this config sets `renderer:` to something other than an object literal — merging into it is your call, not a text edit Reticle should make';
const WRONG_BLOCK_REASON =
  'reticle() is in this file but not in the `renderer` block — the plugin belongs where there is a document, and leaving it in `main` or `preload` would report success for an app that cannot connect';
const MISSING_DESKTOP_REASON =
  'reticle() is already in the `renderer` block but without `desktop: true` — a packaged renderer is a production build with no dev server, so the plugin is dropped from `vite build` and the shipped app has no connect()';

function reticlePluginCall(port: number | undefined): string {
  const options = [
    'desktop: true',
    ...(port === undefined ? [] : [`port: ${String(port)}`]),
    'captureNetworkBodies: true',
  ];
  return `reticle({ ${options.join(', ')} })`;
}

function insertImport(source: string): string {
  if (source.includes(RETICLE_MARKER)) return source;
  const matches = [...source.matchAll(IMPORT_LINE)];
  const last = matches[matches.length - 1];
  if (last?.index === undefined) {
    return `${ELECTRON_VITE_IMPORT}\n${source}`;
  }
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${ELECTRON_VITE_IMPORT}${source.slice(end)}`;
}

function rendererBounds(
  source: string,
): { keyAt: number; braceAt: number; innerStart: number; innerEnd: number } | undefined {
  const key = RENDERER_KEY.exec(source);
  if (key?.index === undefined) return undefined;
  const after = key.index + key[0].length;
  if (source[after] !== '{') return undefined;
  const innerStart = after + 1;
  const innerEnd = matchingBraceEnd(source, innerStart);
  if (innerEnd === undefined) return undefined;
  return { keyAt: key.index, braceAt: after, innerStart, innerEnd };
}

function insertPluginInRenderer(
  source: string,
  bounds: { innerStart: number; innerEnd: number },
  port: number | undefined,
): string {
  const inner = source.slice(bounds.innerStart, bounds.innerEnd);
  const match = PLUGINS_ARRAY.exec(inner);
  if (match?.index === undefined) return source;
  const next = inner[match.index + match[0].length] ?? '';
  const separator = '' === next || /\s/.test(next) ? '' : ' ';
  const patched = `${inner.slice(0, match.index)}${match[0]}${reticlePluginCall(port)},${separator}${inner.slice(match.index + match[0].length)}`;
  return `${source.slice(0, bounds.innerStart)}${patched}${source.slice(bounds.innerEnd)}`;
}

function insertPluginsKeyInRenderer(
  source: string,
  bounds: { braceAt: number },
  port: number | undefined,
): string {
  const rest = source.slice(bounds.braceAt + 1);
  const multiline = /^\s*\n/.test(rest);
  const indent = /^\s*\n(\s*)\S/.exec(rest)?.[1] ?? '  ';
  const key = `plugins: [${reticlePluginCall(port)}],`;
  const inserted = multiline ? `\n${indent}${key}` : ` ${key}`;
  return `${source.slice(0, bounds.braceAt + 1)}${inserted}${source.slice(bounds.braceAt + 1)}`;
}

export function patchElectronViteConfig(source: string, port?: number): SourcePatch {
  const key = RENDERER_KEY.exec(source);
  if (key?.index === undefined) {
    return { kind: PatchKind.MANUAL, reason: NO_RENDERER_REASON };
  }
  const after = key.index + key[0].length;
  if ('{' !== source[after]) {
    return { kind: PatchKind.MANUAL, reason: RENDERER_NOT_LITERAL_REASON };
  }
  const bounds = rendererBounds(source);
  if (bounds === undefined) {
    return { kind: PatchKind.MANUAL, reason: NO_RENDERER_REASON };
  }
  const renderer = source.slice(bounds.innerStart, bounds.innerEnd);
  if (RETICLE_CALL.test(renderer)) {
    if (DESKTOP_FLAG.test(renderer)) {
      return { kind: PatchKind.ALREADY };
    }
    return { kind: PatchKind.MANUAL, reason: MISSING_DESKTOP_REASON };
  }
  if (source.includes(RETICLE_MARKER) || RETICLE_CALL.test(source)) {
    return { kind: PatchKind.MANUAL, reason: WRONG_BLOCK_REASON };
  }
  const withPlugin = PLUGINS_ARRAY.test(renderer)
    ? insertPluginInRenderer(source, bounds, port)
    : insertPluginsKeyInRenderer(source, bounds, port);
  return { kind: PatchKind.APPLY, code: insertImport(withPlugin) };
}

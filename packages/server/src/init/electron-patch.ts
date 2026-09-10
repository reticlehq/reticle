/**
 * Conservative patchers for the Electron halves `init` can see whole: the preload IPC shim and
 * the main-process screenshot helper.
 *
 * Preload is mechanical — prepend one line — so it is APPLY. Main is only APPLY when the file
 * constructs exactly one BrowserWindow as `const <name> = new BrowserWindow(`; anything else
 * (zero, several, a factory) is MANUAL carrying the doctor's existing fix text, not a guess.
 */

import { matchingParenEnd } from './brace-scan.js';
import { CAPTURE_REQUIRE, ELECTRON_CAPTURE_FIX, PRELOAD_REQUIRE } from './desktop-doctor.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

const ESM_PRELOAD_EXT = /\.(?:ts|mts|mjs)$/i;
const WINDOW_DECL = /const\s+(\w+)\s*=\s*new\s+BrowserWindow\s*\(/g;
const IMPORT_LINE = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;
const REQUIRE_LINE = /^(?:const|let|var)\s+.+=\s+require\s*\(/gm;

function isEsmPath(path: string): boolean {
  return ESM_PRELOAD_EXT.test(path);
}

function preloadLine(path: string): string {
  return isEsmPath(path) ? `import '${PRELOAD_REQUIRE}'\n` : `require('${PRELOAD_REQUIRE}');\n`;
}

export function patchElectronPreload(source: string, path: string): SourcePatch {
  if (source.includes(PRELOAD_REQUIRE)) {
    return { kind: PatchKind.ALREADY };
  }
  return { kind: PatchKind.APPLY, code: `${preloadLine(path)}${source}` };
}

function insertMainImport(source: string, path: string): string {
  if (source.includes(CAPTURE_REQUIRE)) return source;
  if (isEsmPath(path)) {
    const line = `import { installReticleCapture } from '${CAPTURE_REQUIRE}'`;
    const matches = [...source.matchAll(IMPORT_LINE)];
    const last = matches[matches.length - 1];
    if (last?.index === undefined) return `${line}\n${source}`;
    const end = last.index + last[0].length;
    return `${source.slice(0, end)}\n${line}${source.slice(end)}`;
  }
  const line = `const { installReticleCapture } = require('${CAPTURE_REQUIRE}');`;
  const matches = [...source.matchAll(REQUIRE_LINE)];
  const last = matches[matches.length - 1];
  if (last?.index === undefined) return `${line}\n${source}`;
  const endOfLine = source.indexOf('\n', last.index);
  const end = endOfLine < 0 ? source.length : endOfLine;
  return `${source.slice(0, end)}\n${line}${source.slice(end)}`;
}

export function patchElectronMain(source: string, path = 'electron/main.cjs'): SourcePatch {
  if (source.includes(CAPTURE_REQUIRE)) {
    return { kind: PatchKind.ALREADY };
  }
  const matches = [...source.matchAll(WINDOW_DECL)];
  if (matches.length !== 1 || matches[0]?.index === undefined || matches[0][1] === undefined) {
    return { kind: PatchKind.MANUAL, reason: ELECTRON_CAPTURE_FIX };
  }
  const name = matches[0][1];
  const openAt = source.indexOf('(', matches[0].index + matches[0][0].length - 1);
  const closeAt = matchingParenEnd(source, openAt);
  if (closeAt === undefined) {
    return { kind: PatchKind.MANUAL, reason: ELECTRON_CAPTURE_FIX };
  }
  let insertAt = closeAt + 1;
  if (';' === source[insertAt]) insertAt += 1;
  const indentMatch = /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', matches[0].index) + 1));
  const indent = indentMatch?.[0] ?? '  ';
  const withCall = `${source.slice(0, insertAt)}\n${indent}installReticleCapture(${name})${source.slice(insertAt)}`;
  return { kind: PatchKind.APPLY, code: insertMainImport(withCall, path) };
}

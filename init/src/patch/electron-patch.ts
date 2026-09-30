/**
 * Conservative patchers for the Electron halves `init` can see whole: the preload IPC shim and
 * the main-process screenshot helper.
 *
 * Preload is mechanical — prepend one line — so it is APPLY. Main is only APPLY when the file
 * constructs exactly one BrowserWindow as `const <name> = new BrowserWindow(`; anything else
 * (zero, several, a factory) is MANUAL carrying the doctor's existing fix text, not a guess.
 *
 * BOTH ARE DEV-ONLY, as the adapter's README says they must be. They used to be written unguarded
 * — a static import in preload, a static import and call in main — so `electron-vite build` and
 * `electron-forge package` bundled the IPC shim (which patches `ipcRenderer.invoke` and exposes
 * `__reticleIpc`) and the screenshot IPC handler into the shipped app. Each is now behind a guard
 * the bundler replaces at build time, so a production build folds the branch away and carries
 * neither. Measured on electron-vite: absent from a production build, present in
 * `--mode development`, which is the build the renderer's `desktop: true` also instruments.
 * A line an older `init` wrote is rewritten in place on a re-run.
 */

import { matchingParenEnd } from './brace-scan.js';
import {
  CAPTURE_REQUIRE,
  ELECTRON_CAPTURE_FIX,
  PRELOAD_REQUIRE,
} from '@/diagnose/desktop-doctor.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

const ESM_PRELOAD_EXT = /\.(?:ts|mts|mjs)$/i;
const WINDOW_DECL = /const\s+(\w+)\s*=\s*new\s+BrowserWindow\s*\(/g;

/** Replaced by Vite in every bundled main and preload, so a production build folds it to false. */
const BUILD_MODE_GUARD = "import.meta.env.MODE !== 'production'";
/**
 * Forge's own dev-server define (`MAIN_WINDOW_VITE_DEV_SERVER_URL` in its template): a URL under
 * `electron-forge start`, undefined in a package, and declared by the template — so it folds AND
 * typechecks, where Forge's `tsconfig` has no types for `import.meta.env`.
 */
const FORGE_DEV_SERVER_DEFINE = /\b([A-Z][A-Z0-9_]*_VITE_DEV_SERVER_URL)\b/;
/** An unbundled CommonJS main has nothing to fold, so it asks at runtime. */
const PACKAGED_GUARD = "!require('electron').app.isPackaged";

/** The unguarded lines an older `init` wrote, rewritten in place on a re-run. */
const LEGACY_PRELOAD_IMPORT = new RegExp(`^import '${PRELOAD_REQUIRE}'\\n`, 'm');
const LEGACY_MAIN_IMPORT = new RegExp(
  `^(?:import \\{ installReticleCapture \\} from '${CAPTURE_REQUIRE}'|const \\{ installReticleCapture \\} = require\\('${CAPTURE_REQUIRE}'\\);)\\n`,
  'm',
);
const LEGACY_MAIN_CALL = /^([ \t]*)installReticleCapture\((\w+)\)[ \t]*;?[ \t]*$/m;

function isEsmPath(path: string): boolean {
  return ESM_PRELOAD_EXT.test(path);
}

/**
 * The shim line, first in the file.
 *
 * A DYNAMIC import behind the build mode, for a bundled preload. Not a `require`: the electron-vite
 * template lints with `no-require-imports`, and a clean install must not fail the project's own lint.
 * Not the static import either, which no guard can remove. The cost is that the shim installs a
 * microtask after the preload body runs rather than before it — still before the page's own
 * scripts, and every exposed API that calls `ipcRenderer.invoke` at call time (electron-toolkit's
 * included) is observed; one that captured the function itself (`invoke: ipcRenderer.invoke`) is
 * not. Verified end to end on electron-vite: IPC observed and screenshots saved in dev, and no
 * Reticle code in a production build.
 *
 * `guarded` is false for a preload that may be SANDBOXED (Forge's template is, by Electron's
 * default): a sandboxed preload can load no second file, so the only form that works there is the
 * static import the bundler inlines. The `.catch` keeps a preload somebody sandboxed anyway from
 * logging an unhandled rejection; the renderer still connects, and the SDK reports IPC as a blind
 * spot rather than letting the silence pass.
 */
function preloadLine(path: string, guarded: boolean): string {
  if (!isEsmPath(path)) return `require('${PRELOAD_REQUIRE}');\n`;
  if (!guarded) return `import '${PRELOAD_REQUIRE}'\n`;
  return (
    `if (${BUILD_MODE_GUARD}) {\n` +
    `  // Reticle IPC observation, dev only — written by \`reticle init\`. A production build drops it.\n` +
    `  void import('${PRELOAD_REQUIRE}').catch(() => undefined)\n` +
    `}\n`
  );
}

export function patchElectronPreload(source: string, path: string, guarded = true): SourcePatch {
  if (guarded && isEsmPath(path) && LEGACY_PRELOAD_IMPORT.test(source)) {
    return {
      kind: PatchKind.APPLY,
      code: `${preloadLine(path, true)}${source.replace(LEGACY_PRELOAD_IMPORT, '')}`,
    };
  }
  if (source.includes(PRELOAD_REQUIRE)) {
    return { kind: PatchKind.ALREADY };
  }
  return { kind: PatchKind.APPLY, code: `${preloadLine(path, guarded)}${source}` };
}

/** The guarded capture call for this main file. Nothing to import at the top: it loads itself. */
function captureCall(source: string, path: string, windowName: string): string {
  if (!isEsmPath(path)) {
    return `if (${PACKAGED_GUARD}) require('${CAPTURE_REQUIRE}').installReticleCapture(${windowName})`;
  }
  const guard = FORGE_DEV_SERVER_DEFINE.exec(source)?.[1] ?? BUILD_MODE_GUARD;
  return `if (${guard}) void import('${CAPTURE_REQUIRE}').then(({ installReticleCapture }) => installReticleCapture(${windowName}))`;
}

export function patchElectronMain(source: string, path = 'electron/main.cjs'): SourcePatch {
  const legacyCall = LEGACY_MAIN_CALL.exec(source);
  if (LEGACY_MAIN_IMPORT.test(source) && legacyCall?.[2] !== undefined) {
    const withoutImport = source.replace(LEGACY_MAIN_IMPORT, '');
    const indent = legacyCall[1] ?? '';
    return {
      kind: PatchKind.APPLY,
      code: withoutImport.replace(
        LEGACY_MAIN_CALL,
        `${indent}${captureCall(withoutImport, path, legacyCall[2])}`,
      ),
    };
  }
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
  const call = captureCall(source, path, name);
  return {
    kind: PatchKind.APPLY,
    code: `${source.slice(0, insertAt)}\n${indent}${call}${source.slice(insertAt)}`,
  };
}

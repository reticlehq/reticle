import { describe, expect, it } from 'vitest';
import { PatchKind } from './patch-kind.js';
import { ELECTRON_CAPTURE_FIX, PRELOAD_REQUIRE } from '@/diagnose/desktop-doctor.js';
import { patchElectronMain, patchElectronPreload } from './electron-patch.js';

const ESM_PRELOAD = `import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
}
`;

const CJS_PRELOAD = `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('api', {});
`;

const SINGLE_WINDOW = `import { app, BrowserWindow } from 'electron'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    webPreferences: { preload: 'preload.js' }
  })

  mainWindow.loadURL('http://localhost:5173')
}
`;

describe('patchElectronPreload', () => {
  /**
   * Forge's preload was given the static import, which no guard can remove, so `electron-forge
   * package` shipped the IPC shim. Measured on a scaffolded Forge 8 app: Forge builds its preload
   * with `codeSplitting: false` and the real build mode, so the guarded dynamic import is inlined
   * into the one sandbox-safe file under `development` and folds away under `production`. Forge's
   * tsconfig has no `import.meta.env` types, which the reference supplies.
   */
  it('guards the shim for a Forge preload too, with the vite types its tsconfig lacks', () => {
    const r = patchElectronPreload(ESM_PRELOAD, 'src/preload.ts', true);
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code.startsWith('/// <reference types="vite/client" />\n')).toBe(true);
    expect(r.code).toContain("if (import.meta.env.MODE !== 'production') {");
    expect(r.code).not.toContain(`import '${PRELOAD_REQUIRE}'`);
    expect(r.code).toContain('contextBridge');
    expect(patchElectronPreload(r.code, 'src/preload.ts', true).kind).toBe(PatchKind.ALREADY);
  });

  it('rewrites the unguarded import an older init wrote into a Forge preload', () => {
    const legacy = `import '${PRELOAD_REQUIRE}'\n${ESM_PRELOAD}`;
    const r = patchElectronPreload(legacy, 'src/preload.ts', true);
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code).not.toContain(`import '${PRELOAD_REQUIRE}'`);
    expect(r.code.match(/@reticlehq\/electron\/preload/g)).toHaveLength(1);
  });

  /**
   * The shim was a static import with no dev guard, so `electron-vite build` bundled it into the
   * packaged preload. `import.meta.env.MODE` is replaced at build time, so a production build folds
   * the branch away and the output carries no Reticle code (measured on electron-vite: gone in a
   * production build, present in `--mode development`, which the renderer's `desktop: true` also
   * instruments).
   */
  it('guards the shim on the build mode for an electron-vite preload, still first', () => {
    const r = patchElectronPreload(ESM_PRELOAD, 'src/preload/index.ts');
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code.startsWith("if (import.meta.env.MODE !== 'production') {")).toBe(true);
    expect(r.code).toContain(`void import('${PRELOAD_REQUIRE}')`);
    // Not a require(): the electron-vite template lints with no-require-imports.
    expect(r.code).not.toContain(`require('${PRELOAD_REQUIRE}')`);
    expect(r.code).not.toContain(`import '${PRELOAD_REQUIRE}'`);
    expect(patchElectronPreload(r.code, 'src/preload/index.ts').kind).toBe(PatchKind.ALREADY);
  });

  it('rewrites the unguarded import an older init wrote, in place', () => {
    const legacy = `import '${PRELOAD_REQUIRE}'\n${ESM_PRELOAD}`;
    const r = patchElectronPreload(legacy, 'src/preload/index.ts');
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code).not.toContain(`import '${PRELOAD_REQUIRE}'`);
    expect(r.code.match(/@reticlehq\/electron\/preload/g)).toHaveLength(1);
    expect(r.code.startsWith("if (import.meta.env.MODE !== 'production') {")).toBe(true);
  });

  it('prepends a require for .cjs', () => {
    const r = patchElectronPreload(CJS_PRELOAD, 'electron/preload.cjs');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code.startsWith(`require('${PRELOAD_REQUIRE}')`)).toBe(true);
  });

  it('is idempotent', () => {
    const first = patchElectronPreload(ESM_PRELOAD, 'src/preload/index.ts');
    expect(first.kind).toBe(PatchKind.APPLY);
    if (first.kind !== PatchKind.APPLY) return;
    expect(patchElectronPreload(first.code, 'src/preload/index.ts').kind).toBe(PatchKind.ALREADY);
  });
});

describe('patchElectronMain', () => {
  it('inserts installReticleCapture after a single BrowserWindow constructor', () => {
    const r = patchElectronMain(SINGLE_WINDOW, 'src/main/index.ts');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    // A dynamic import behind the build mode, never a static one: the static import put the capture
    // handler into every packaged main bundle.
    expect(r.code).not.toContain(
      "import { installReticleCapture } from '@reticlehq/electron/main'",
    );
    expect(r.code).toContain(
      "if (import.meta.env.MODE !== 'production') void import('@reticlehq/electron/main').then(({ installReticleCapture }) => installReticleCapture(mainWindow))",
    );
    const ctorEnd = r.code.indexOf('})');
    const callAt = r.code.indexOf('installReticleCapture(mainWindow)');
    expect(callAt).toBeGreaterThan(ctorEnd);
  });

  it('guards a Forge main on the dev-server URL the file already branches on', () => {
    // Forge defines `<NAME>_VITE_DEV_SERVER_URL` at build time, undefined in a package, and its
    // template declares it — so it folds AND typechecks, where `import.meta.env` does not.
    const forge = SINGLE_WINDOW.replace(
      "  mainWindow.loadURL('http://localhost:5173')",
      '  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {\n    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)\n  }',
    );
    const r = patchElectronMain(forge, 'src/main.ts');
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code).toContain(
      "if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void import('@reticlehq/electron/main')",
    );
    expect(r.code).not.toContain('import.meta.env');
  });

  it('guards an unbundled CommonJS main on app.isPackaged', () => {
    const cjs = SINGLE_WINDOW.replace(
      "import { app, BrowserWindow } from 'electron'",
      "const { app, BrowserWindow } = require('electron')",
    );
    const r = patchElectronMain(cjs, 'electron/main.cjs');
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code).toContain(
      "if (!require('electron').app.isPackaged) require('@reticlehq/electron/main').installReticleCapture(mainWindow)",
    );
    expect(patchElectronMain(r.code, 'electron/main.cjs').kind).toBe(PatchKind.ALREADY);
  });

  it('rewrites the unguarded import and call an older init wrote, in place', () => {
    const legacy = SINGLE_WINDOW.replace(
      "import { app, BrowserWindow } from 'electron'",
      "import { app, BrowserWindow } from 'electron'\nimport { installReticleCapture } from '@reticlehq/electron/main'",
    ).replace('  })\n', '  })\n  installReticleCapture(mainWindow)\n');
    const r = patchElectronMain(legacy, 'src/main/index.ts');
    if (r.kind !== PatchKind.APPLY) throw new Error(r.kind);
    expect(r.code).not.toContain('import { installReticleCapture }');
    expect(r.code.match(/installReticleCapture\(mainWindow\)/g)).toHaveLength(1);
    expect(r.code).toContain("if (import.meta.env.MODE !== 'production') void import(");
    expect(patchElectronMain(r.code, 'src/main/index.ts').kind).toBe(PatchKind.ALREADY);
  });

  it('is idempotent', () => {
    const first = patchElectronMain(SINGLE_WINDOW, 'src/main/index.ts');
    expect(first.kind).toBe(PatchKind.APPLY);
    if (first.kind !== PatchKind.APPLY) return;
    expect(patchElectronMain(first.code, 'src/main/index.ts').kind).toBe(PatchKind.ALREADY);
  });

  it('bails to the doctor fix when there are several windows', () => {
    const src = `const a = new BrowserWindow({})
const b = new BrowserWindow({})`;
    const r = patchElectronMain(src, 'src/main/index.ts');
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toBe(ELECTRON_CAPTURE_FIX);
  });

  it('bails to the doctor fix when the window is built by a factory', () => {
    const src = `function make() { return new BrowserWindow({}) }
const win = make()`;
    const r = patchElectronMain(src, 'electron/main.cjs');
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toBe(ELECTRON_CAPTURE_FIX);
  });
});

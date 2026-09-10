import { describe, expect, it } from 'vitest';
import { PatchKind } from './patch-kind.js';
import { ELECTRON_CAPTURE_FIX, PRELOAD_REQUIRE } from './desktop-doctor.js';
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
  it('prepends an ESM import for .ts', () => {
    const r = patchElectronPreload(ESM_PRELOAD, 'src/preload/index.ts');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code.startsWith(`import '${PRELOAD_REQUIRE}'`)).toBe(true);
    expect(r.code).toContain('contextBridge');
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
    expect(r.code).toContain("import { installReticleCapture } from '@reticlehq/electron/main'");
    expect(r.code).toContain('installReticleCapture(mainWindow)');
    const ctorEnd = r.code.indexOf('})');
    const callAt = r.code.indexOf('installReticleCapture(mainWindow)');
    expect(callAt).toBeGreaterThan(ctorEnd);
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

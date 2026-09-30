/**
 * Electron Forge's Vite template was invisible to `init`.
 *
 * Forge splits its Vite config three ways — `vite.main.config.ts`, `vite.preload.config.ts`,
 * `vite.renderer.config.ts` — and has no `vite.config.*` at all. Detection and the config lookup
 * both asked only for `vite.config.*`, so a Forge app got the generic manual Vite step, no preload
 * shim, no capture helper, and a re-run that exited 1 forever because the ⚠ could never clear.
 *
 * The renderer config is an ordinary Vite config and the only one with a document, so it is the one
 * that gets the plugin; the preload and main halves are the same two patches electron-vite gets.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, UiLibrary, type DetectInput } from './detect/detect.js';
import { frameworkPackages } from './plan/plan.js';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';
import { PRELOAD_REQUIRE, CAPTURE_REQUIRE } from './diagnose/desktop-doctor.js';

const FORGE_PKG = {
  name: 'forge-app',
  main: '.vite/build/main.js',
  scripts: { start: 'electron-forge start', package: 'electron-forge package' },
  devDependencies: {
    '@electron-forge/cli': '^7.11.0',
    '@electron-forge/plugin-vite': '^7.11.0',
    electron: '^44.0.0',
    typescript: '^5.9.0',
    vite: '^7.0.0',
  },
  dependencies: { 'electron-squirrel-startup': '^1.0.1' },
};

const RENDERER_CONFIG = `import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({});
`;

const MAIN_TS = `import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

if (started) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: PRELOAD_ENTRY,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(RENDERER_INDEX);
  }
};

app.on('ready', createWindow);
`;

const PRELOAD_TS = `// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
`;

const FORGE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(FORGE_PKG),
  'forge.config.ts': 'export default {};\n',
  'vite.main.config.ts': RENDERER_CONFIG,
  'vite.preload.config.ts': RENDERER_CONFIG,
  'vite.renderer.config.ts': RENDERER_CONFIG,
  'index.html':
    '<!doctype html><html><body><script type="module" src="/src/renderer.ts"></script></body></html>\n',
  'src/main.ts': MAIN_TS,
  'src/preload.ts': PRELOAD_TS,
  'src/renderer.ts': "import './index.css';\n",
  'tsconfig.json': '{}\n',
};

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: false,
  install: false,
  dryRun: false,
};

const detectInput = (over: Partial<DetectInput>): DetectInput => ({
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
  ...over,
});

describe('detecting Electron Forge', () => {
  it('is Forge, not the plain Vite app its `vite` dependency made it look like', () => {
    const detection = detect(
      detectInput({ pkg: FORGE_PKG, configFiles: new Set(['vite.renderer.config.ts']) }),
    );
    expect(detection.framework).toBe(Framework.ELECTRON_FORGE);
  });

  it('is recognised from its renderer config alone', () => {
    const detection = detect(detectInput({ configFiles: new Set(['vite.renderer.config.ts']) }));
    expect(detection.framework).toBe(Framework.ELECTRON_FORGE);
  });

  it('does not install the React adapter into a template that renders no React', () => {
    const packages = frameworkPackages(Framework.ELECTRON_FORGE, UiLibrary.UNKNOWN);
    expect(packages).not.toContain('@reticlehq/react');
    expect(packages).toEqual([
      '@reticlehq/browser',
      '@reticlehq/vite-plugin',
      '@reticlehq/electron',
    ]);
  });

  it('still gives a React renderer the React adapter', () => {
    expect(frameworkPackages(Framework.ELECTRON_FORGE, UiLibrary.REACT)).toContain(
      '@reticlehq/react',
    );
  });
});

describe('init on the Forge Vite template', () => {
  it('patches the renderer config, the preload and main — and nothing is left to do by hand', () => {
    const io = memoryIo(FORGE_FILES);
    const result = runInit(OPTS, io);
    expect(io.written['vite.renderer.config.ts']).toContain('reticle(');
    expect(io.written['vite.renderer.config.ts']).toContain('@reticlehq/vite-plugin');
    // The main-process and preload builds have no document; the plugin must not land there.
    expect(io.written['vite.main.config.ts']).toBeUndefined();
    expect(io.written['vite.preload.config.ts']).toBeUndefined();
    expect(io.written['src/preload.ts']).toContain(PRELOAD_REQUIRE);
    expect(io.written['src/main.ts']).toContain(CAPTURE_REQUIRE);
    expect(io.written['src/main.ts']).toContain('installReticleCapture(mainWindow)');
    expect(result.ok).toBe(true);
    expect(io.lines.join('\n')).not.toContain('will NOT connect');
  });

  it('is idempotent: a second run changes nothing and exits green', () => {
    const io = memoryIo(FORGE_FILES);
    runInit(OPTS, io);
    const again = memoryIo({ ...FORGE_FILES, ...io.written });
    const result = runInit(OPTS, again);
    expect(result.ok).toBe(true);
    for (const path of ['vite.renderer.config.ts', 'src/main.ts', 'src/preload.ts']) {
      expect(again.written[path], path).toBeUndefined();
    }
  });
});

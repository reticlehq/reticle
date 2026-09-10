import { describe, expect, it } from 'vitest';
import { diagnoseDesktop, DesktopFinding } from './desktop-doctor.js';

/** A fake project: path → contents. Anything absent simply does not exist. */
const project = (files: Record<string, string>) => (path: string) => files[path];

const TAURI_CONF = 'src-tauri/tauri.conf.json';
const csp = (value: string) => JSON.stringify({ app: { security: { csp: value } } });

const GOOD_CSP =
  "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost ws://localhost:4400";

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('diagnoseDesktop — Tauri', () => {
  it('says nothing when there is no desktop project here', () => {
    expect(diagnoseDesktop(project({ 'package.json': '{"name":"web-app"}' }), 4400)).toEqual([]);
  });

  /**
   * The single most common Tauri failure, and it is SILENT: a restrictive default CSP blocks the
   * bridge WebSocket before it opens, so the app runs perfectly and simply never appears in
   * `reticle status`. Nothing in the app's own console explains it.
   */
  it('catches a CSP that does not allow the bridge WebSocket', () => {
    const findings = diagnoseDesktop(
      project({ [TAURI_CONF]: csp("default-src 'self'; connect-src 'self'") }),
      4400,
    );
    expect(codes(findings)).toContain(DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE);
    // The fix must be copy-pasteable, including the port actually in use.
    expect(findings[0]?.fix).toContain('ws://localhost:4400');
  });

  it('accepts a CSP that already allows it', () => {
    const findings = diagnoseDesktop(project({ [TAURI_CONF]: csp(GOOD_CSP) }), 4400);
    expect(codes(findings)).not.toContain(DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE);
  });

  it('checks the port actually in use, not a hardcoded default', () => {
    const findings = diagnoseDesktop(project({ [TAURI_CONF]: csp(GOOD_CSP) }), 4460);
    expect(codes(findings)).toContain(DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE);
  });

  it('accepts a wildcard port allowance', () => {
    const wild = "connect-src 'self' ipc: http://ipc.localhost ws://localhost:*";
    expect(codes(diagnoseDesktop(project({ [TAURI_CONF]: csp(wild) }), 4400))).not.toContain(
      DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE,
    );
  });

  /**
   * A CSP with no `csp` key at all means Tauri's default applies — which blocks the bridge. Absent
   * is not the same as permissive, and reporting it as fine would be a false green.
   */
  it('treats a missing csp key as blocking, not as permissive', () => {
    const findings = diagnoseDesktop(project({ [TAURI_CONF]: JSON.stringify({ app: {} }) }), 4400);
    expect(codes(findings)).toContain(DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE);
  });

  it('warns when a custom CSP dropped the ipc: source Tauri itself needs', () => {
    const noIpc = "connect-src 'self' ws://localhost:4400";
    expect(codes(diagnoseDesktop(project({ [TAURI_CONF]: csp(noIpc) }), 4400))).toContain(
      DesktopFinding.TAURI_CSP_BLOCKS_IPC,
    );
  });

  it('does not crash on a malformed tauri.conf.json', () => {
    expect(() => diagnoseDesktop(project({ [TAURI_CONF]: '{ not json' }), 4400)).not.toThrow();
  });
});

describe('diagnoseDesktop — Electron', () => {
  const electronPkg = JSON.stringify({
    name: 'app',
    main: 'electron/main.cjs',
    devDependencies: { electron: '^34.0.0' },
  });

  it('catches a preload that never installs the IPC shim', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': electronPkg,
        'electron/main.cjs': 'require("electron")',
        'electron/preload.cjs': 'const { contextBridge } = require("electron")',
      }),
      4400,
    );
    expect(codes(findings)).toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });

  it('catches a main process that never installs the capture helper', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': electronPkg,
        'electron/main.cjs': 'require("electron")',
        'electron/preload.cjs': 'require("@reticlehq/electron/preload")',
      }),
      4400,
    );
    expect(codes(findings)).toContain(DesktopFinding.ELECTRON_CAPTURE_MISSING);
  });

  it('is quiet when both halves are wired', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': electronPkg,
        'electron/main.cjs':
          'const { installReticleCapture } = require("@reticlehq/electron/main")',
        'electron/preload.cjs': 'require("@reticlehq/electron/preload")',
      }),
      4400,
    );
    expect(findings).toEqual([]);
  });

  it('finds the preload next to whatever main the package.json declares', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': JSON.stringify({
          main: 'app/desktop/main.cjs',
          devDependencies: { electron: '^34' },
        }),
        'app/desktop/main.cjs': 'require("@reticlehq/electron/main")',
        'app/desktop/preload.cjs': 'require("@reticlehq/electron/preload")',
      }),
      4400,
    );
    expect(findings).toEqual([]);
  });
});

describe('diagnoseDesktop — must not cry wolf on a bundled preload', () => {
  /**
   * electron-vite and Electron Forge BUNDLE the preload — which is the setup this project
   * recommends, because it keeps sandboxing on. There is then no `preload.cjs` sibling to read:
   * `main` points into a build directory and the require is inlined at build time.
   *
   * Reporting "preload missing" there is worse than saying nothing: it tells someone who did the
   * right thing to change it. A checker that cannot see must say so, not guess.
   */
  it('stays silent when the preload cannot be located at all', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': JSON.stringify({
          main: 'out/main/index.js',
          devDependencies: { electron: '^34', 'electron-vite': '^2' },
        }),
        'out/main/index.js': '// bundled output, the require is inlined',
      }),
      4400,
    );
    expect(codes(findings)).not.toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });

  it('still reports a preload it CAN see that lacks the shim', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': JSON.stringify({
          main: 'electron/main.cjs',
          devDependencies: { electron: '^34' },
        }),
        'electron/main.cjs': 'require("@reticlehq/electron/main")',
        'electron/preload.cjs': 'const { contextBridge } = require("electron")',
      }),
      4400,
    );
    expect(codes(findings)).toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });

  it('finds a preload kept in a src/ directory rather than beside main', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': JSON.stringify({
          main: 'dist/main.js',
          devDependencies: { electron: '^34' },
        }),
        'dist/main.js': 'require("@reticlehq/electron/main")',
        'src/preload.ts': 'require("@reticlehq/electron/preload")',
      }),
      4400,
    );
    expect(findings).toEqual([]);
  });
});

describe('diagnoseDesktop — verifying a bundled preload from its ARTIFACT', () => {
  const bundledPkg = JSON.stringify({
    main: 'out/main/index.js',
    devDependencies: { electron: '^34', 'electron-vite': '^2' },
  });

  /**
   * Staying silent on a bundled preload stopped the false alarm, but it also meant the recommended
   * setup could never be verified at all. It can be: bundling INLINES the shim, and the shim carries
   * the contract's own window global. Finding that string in the build output is proof the preload
   * is wired — checking the artifact instead of the source it was built from.
   */
  it('accepts a bundled preload whose output carries the contract marker', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': bundledPkg,
        'out/main/index.js': 'require("@reticlehq/electron/main")',
        'out/preload/index.js': 'contextBridge.exposeInMainWorld("__reticleIpc", {...})',
      }),
      4400,
    );
    expect(codes(findings)).not.toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });

  /** A build output we CAN read and which lacks the marker is a genuine miss, not an unknown. */
  it('reports a bundled preload whose output lacks the marker', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': bundledPkg,
        'out/main/index.js': 'require("@reticlehq/electron/main")',
        'out/preload/index.js': 'contextBridge.exposeInMainWorld("api", {...})',
      }),
      4400,
    );
    expect(codes(findings)).toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });

  it('still says nothing when there is neither a source nor a build output to read', () => {
    const findings = diagnoseDesktop(
      project({
        'package.json': bundledPkg,
        'out/main/index.js': 'require("@reticlehq/electron/main")',
      }),
      4400,
    );
    expect(codes(findings)).not.toContain(DesktopFinding.ELECTRON_PRELOAD_MISSING);
  });
});

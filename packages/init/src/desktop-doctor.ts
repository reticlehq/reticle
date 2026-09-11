import { RETICLE_IPC_GLOBAL } from '@reticlehq/core';

/**
 * Setup RCA for desktop apps.
 *
 * Every failure this catches is SILENT. A Tauri app with the default CSP runs perfectly and simply
 * never appears in `reticle status` — the WebSocket is blocked before it opens, and nothing in the
 * app's own console says so. An Electron app missing the preload line works fine and reports zero
 * network activity forever, which reads as "the app makes no backend calls" rather than "you are
 * blind to all of them".
 *
 * Silent misconfiguration is the same disease as a false green: the tool answers confidently and the
 * answer is wrong. So the diagnosis names the file, the reason, and the exact line to add.
 *
 * Pure: a `read` function in, findings out. No fs, no cwd, no process.
 */

export const DesktopFinding = {
  /** Tauri's CSP will block the bridge WebSocket — the app will never connect, with no error. */
  TAURI_CSP_BLOCKS_BRIDGE: 'tauri-csp-blocks-bridge',
  /** A custom CSP dropped the `ipc:` source Tauri needs for `invoke` itself. */
  TAURI_CSP_BLOCKS_IPC: 'tauri-csp-blocks-ipc',
  /** The preload never requires the shim, so every IPC call is invisible. */
  ELECTRON_PRELOAD_MISSING: 'electron-preload-missing',
  /** The main process never installs the capture helper, so screenshots are unavailable. */
  ELECTRON_CAPTURE_MISSING: 'electron-capture-missing',
} as const;
export type DesktopFinding = (typeof DesktopFinding)[keyof typeof DesktopFinding];

export interface DesktopDiagnosis {
  code: DesktopFinding;
  /** Which file to look at. */
  file: string;
  /** What is wrong, in one line. */
  problem: string;
  /** Exactly what to add — copy-pasteable, with the port actually in use. */
  fix: string;
}

/** Reads a project-relative path. Undefined means the file does not exist. */
type ReadFile = (path: string) => string | undefined;

const TAURI_CONF = 'src-tauri/tauri.conf.json';
export const PRELOAD_REQUIRE = '@reticlehq/electron/preload';
export const CAPTURE_REQUIRE = '@reticlehq/electron/main';
/** The copy-pasteable line `diagnoseDesktop` already prints; the main patcher reuses it on MANUAL. */
export const ELECTRON_CAPTURE_FIX = `add:  const { installReticleCapture } = require('${CAPTURE_REQUIRE}')  then installReticleCapture(win)`;
export const ELECTRON_PRELOAD_FIX = `add as the FIRST line:  require('${PRELOAD_REQUIRE}')`;

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return 'object' === typeof parsed && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // a malformed config is the app's problem, not something to crash the doctor on
  }
}

function record(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Does this CSP permit the bridge WebSocket on `port`?
 *
 * A MISSING csp key is treated as blocking, not permissive: Tauri applies a restrictive default, so
 * reporting "no CSP, therefore fine" would be precisely the false green this tool exists to prevent.
 */
function cspAllowsBridge(csp: string | undefined, port: number): boolean {
  if (csp === undefined) return false;
  const exact = `ws://localhost:${String(port)}`;
  const loopback = `ws://127.0.0.1:${String(port)}`;
  // A BARE `ws:` scheme source allows any ws origin. It must be matched as a whole source, not as a
  // substring: `includes('ws:')` also matches `ws://localhost:4400`, which would make every port
  // look allowed and silently defeat the port check this function exists to perform.
  const bareScheme = /(^|[\s;])ws:(?!\/\/)/.test(csp);
  return (
    csp.includes(exact) ||
    csp.includes(loopback) ||
    csp.includes('ws://localhost:*') ||
    csp.includes('ws://127.0.0.1:*') ||
    bareScheme
  );
}

/** Tauri v2 needs `ipc:`/`http://ipc.localhost` in connect-src for `invoke` to work at all. */
function cspAllowsIpc(csp: string): boolean {
  return csp.includes('ipc:') || csp.includes('ipc.localhost');
}

function diagnoseTauri(read: ReadFile, port: number): DesktopDiagnosis[] {
  const conf = parseJson(read(TAURI_CONF));
  if (conf === undefined) return [];
  const security = record(record(conf['app'])['security']);
  const csp = 'string' === typeof security['csp'] ? security['csp'] : undefined;
  const findings: DesktopDiagnosis[] = [];

  if (!cspAllowsBridge(csp, port)) {
    findings.push({
      code: DesktopFinding.TAURI_CSP_BLOCKS_BRIDGE,
      file: TAURI_CONF,
      problem:
        csp === undefined
          ? "no `app.security.csp` set, so Tauri's restrictive default applies and blocks the Reticle bridge — the app will run normally and never connect"
          : 'the CSP `connect-src` does not allow the Reticle bridge WebSocket — the app will run normally and never connect',
      fix: `add to app.security.csp connect-src:  ws://localhost:${String(port)}`,
    });
  }
  if (csp !== undefined && !cspAllowsIpc(csp)) {
    findings.push({
      code: DesktopFinding.TAURI_CSP_BLOCKS_IPC,
      file: TAURI_CONF,
      problem: 'the CSP dropped the `ipc:` source Tauri needs — `invoke` itself will fail',
      fix: 'add to app.security.csp connect-src:  ipc: http://ipc.localhost',
    });
  }
  return findings;
}

/** The directory portion of a path, without pulling in node:path (this module stays pure). */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut + 1);
}

/**
 * Where a preload SOURCE might live, in the order worth trying.
 *
 * Beside `main` first (the unbundled layout), then the usual source directories — a bundled setup
 * points `main` at `out/` or `dist/` while the real preload stays in `src/` or `electron/`.
 */
function preloadCandidates(mainDir: string): string[] {
  const names = ['preload.cjs', 'preload.js', 'preload.mjs', 'preload.ts', 'preload.mts'];
  const dirs = [mainDir, 'electron/', 'src/', 'src/preload/', 'src/main/', ''];
  return dirs.flatMap((dir) => names.map((name) => `${dir}${name}`));
}

/**
 * Where a BUNDLED preload's output lands. electron-vite's default layout mirrors `out/main` with
 * `out/preload`; Forge and hand-rolled setups favour `dist`/`build`.
 */
function bundledPreloadCandidates(mainDir: string): string[] {
  const roots = [mainDir.replace(/main\/?$/, ''), 'out/', 'dist/', 'build/', '.vite/build/'];
  const names = [
    'preload/index.js',
    'preload/index.mjs',
    'preload/index.cjs',
    'preload.js',
    'preload.mjs',
    'preload.cjs',
  ];
  return roots.flatMap((root) => names.map((name) => `${root}${name}`));
}

/**
 * Is the preload wired, judged from whatever evidence exists?
 *
 * Source first (the require is right there). Failing that, the BUILD OUTPUT: bundling inlines the
 * shim, and the shim carries the contract's own window global — finding that string in the artifact
 * proves the preload is wired even though the require has been compiled away. Undefined means no
 * evidence either way, and an unknown must never be reported as a fault.
 */
function preloadWired(
  read: ReadFile,
  mainDir: string,
): { wired: boolean; file: string } | undefined {
  for (const candidate of preloadCandidates(mainDir)) {
    const source = read(candidate);
    if (source !== undefined) return { wired: source.includes(PRELOAD_REQUIRE), file: candidate };
  }
  for (const candidate of bundledPreloadCandidates(mainDir)) {
    const built = read(candidate);
    if (built !== undefined) {
      return { wired: built.includes(RETICLE_IPC_GLOBAL), file: candidate };
    }
  }
  return undefined;
}

function diagnoseElectron(read: ReadFile, main: string): DesktopDiagnosis[] {
  const findings: DesktopDiagnosis[] = [];
  const dir = dirOf(main);
  // Undefined = no source AND no build output to judge from. An unknown is not a fault.
  const preload = preloadWired(read, dir);

  if (preload !== undefined && !preload.wired) {
    findings.push({
      code: DesktopFinding.ELECTRON_PRELOAD_MISSING,
      file: preload.file,
      problem:
        'the preload never installs the Reticle IPC shim, so every ipcRenderer.invoke is invisible — reticle_network will report nothing and read as "this app makes no backend calls"',
      fix: ELECTRON_PRELOAD_FIX,
    });
  }

  const mainSource = read(main);
  if (mainSource !== undefined && !mainSource.includes(CAPTURE_REQUIRE)) {
    findings.push({
      code: DesktopFinding.ELECTRON_CAPTURE_MISSING,
      file: main,
      problem: 'the main process never installs the capture helper, so screenshots are unavailable',
      fix: ELECTRON_CAPTURE_FIX,
    });
  }
  return findings;
}

/** Is this project a desktop shell at all? Used to print a positive result instead of silence. */
export function isDesktopProject(read: ReadFile): boolean {
  if (read(TAURI_CONF) !== undefined) return true;
  const pkg = parseJson(read('package.json'));
  if (pkg === undefined) return false;
  const deps = { ...record(pkg['dependencies']), ...record(pkg['devDependencies']) };
  return deps['electron'] !== undefined;
}

/** Which desktop shell (if any) this project is, and what is missing from its Reticle wiring. */
export function diagnoseDesktop(read: ReadFile, port: number): DesktopDiagnosis[] {
  const tauri = diagnoseTauri(read, port);
  if (tauri.length > 0 || read(TAURI_CONF) !== undefined) return tauri;

  const pkg = parseJson(read('package.json'));
  if (pkg === undefined) return [];
  const deps = { ...record(pkg['dependencies']), ...record(pkg['devDependencies']) };
  if (deps['electron'] === undefined) return [];
  const main = 'string' === typeof pkg['main'] ? pkg['main'] : undefined;
  return main === undefined ? [] : diagnoseElectron(read, main);
}

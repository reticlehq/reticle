import { dirname, join, relative, sep } from 'node:path';
import type { InitIo } from '@/run-types.js';
import { DEV_SCRIPT_NAMES } from './dev-script.js';
import { detect, Framework, UiLibrary } from './detect.js';

/**
 * The file names that say what a directory IS, shared by everything that has to ask.
 *
 * They lived in run.ts and are read from here now because `findWorkspaceApps` moved and needs them —
 * one definition, imported in both directions of the question ("is this an app?" and "which app?").
 */

export const PACKAGE_JSON = 'package.json';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
export const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];
export const ELECTRON_VITE_CONFIG_CANDIDATES = [
  'electron.vite.config.ts',
  'electron.vite.config.js',
  'electron.vite.config.mjs',
  'electron.vite.config.mts',
];
export const NEXT_CONFIG_CANDIDATES = [
  'next.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.cjs',
];
/**
 * Which directories to look in for the app, when `reticle init` runs at a monorepo root.
 *
 * This used to be the literal list `['apps', 'packages']`. Measured on a real repo with three Next
 * apps at `web/`, `admin/` and `space/`, it found none — so the redirect never fired, init ran
 * against the root, and it reported ✓ for writing `app/reticle-dev.tsx` into a directory Next never
 * compiles. A ⚠ tells a human to act; a ✓ tells them it is handled.
 *
 * A workspace DECLARES its packages, so that declaration is used first and directory names are not
 * guessed at all. Where nothing is declared, every top-level directory is a better candidate than two
 * hardcoded ones — filtered by the usual non-source suspects, and still subject to the `looksLikeApp`
 * check that follows, so a wrong guess here costs a `package.json` read.
 */

/** Directories that are never a workspace package, whatever the layout. */
const NEVER_A_PACKAGE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target']);

interface WorkspaceSources {
  /** Raw contents of pnpm-workspace.yaml, when present. */
  pnpmWorkspace?: string;
  /** The `workspaces` field of package.json — array form or the yarn/npm object form. */
  pkgWorkspaces?: unknown;
  /** Directory names at the repo root, used when nothing is declared. */
  topLevelDirs?: readonly string[];
}

/** `packages/*` -> `packages`; `web` -> `web`. The base directory a glob searches. */
function globBase(pattern: string): string | undefined {
  const base = pattern
    .split('/')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  return base === undefined || '' === base || '.' === base || base.includes('*') ? undefined : base;
}

function fromPnpm(yaml: string): string[] {
  // A deliberately small reader rather than a YAML dependency: this file is a list of globs, and the
  // only shape that matters is `- 'pattern'` under `packages:`. A malformed file yields nothing,
  // which falls through to the top-level scan rather than failing the install.
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (inPackages && item?.[1] !== undefined) {
      const base = globBase(item[1]);
      if (base !== undefined) out.push(base);
    }
  }
  return out;
}

function fromPkg(workspaces: unknown): string[] {
  const list = Array.isArray(workspaces)
    ? workspaces
    : 'object' === typeof workspaces && workspaces !== null
      ? (workspaces as { packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is string => 'string' === typeof p)
    .map(globBase)
    .filter((p): p is string => p !== undefined);
}

export function workspaceParents(sources: WorkspaceSources): string[] {
  const declared = [
    ...(sources.pnpmWorkspace === undefined ? [] : fromPnpm(sources.pnpmWorkspace)),
    ...fromPkg(sources.pkgWorkspaces),
  ];
  const candidates =
    declared.length > 0
      ? declared
      : (sources.topLevelDirs ?? []).filter((d) => !d.startsWith('.') && !NEVER_A_PACKAGE.has(d));
  return [...new Set(candidates)];
}

/**
 * Which directories under this workspace are runnable apps.
 *
 * A general-purpose question about a repository's shape, so it lives next to `workspaceParents`,
 * which answers the other half of it.
 */
/** Deps that mark a directory as a runnable web app even when it has no bundler config file. */
export const APP_DEPS = ['next', 'vite', 'electron-vite'] as const;

function hasDevScript(pkgRaw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(pkgRaw);
    const scripts =
      'object' === typeof parsed && parsed !== null
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    if ('object' !== typeof scripts || null === scripts) return false;
    const named = scripts as Record<string, unknown>;
    return DEV_SCRIPT_NAMES.some((n) => 'string' === typeof named[n] && '' !== named[n]);
  } catch {
    // A manifest that will not parse says nothing either way, and this is a filter, not a verdict.
    return false;
  }
}

/** How strongly a directory claims to be the app somebody is working in. */
const AppSignal = {
  /** A page to connect: a bundler, a UI framework, or an index.html of its own. */
  UI: 'ui',
  /** Something that can be served and shows no page — an API, a worker, a server-rendered backend. */
  SERVED: 'served',
  NONE: 'none',
} as const;
type AppSignal = (typeof AppSignal)[keyof typeof AppSignal];

/** The pages a package can serve without any framework to say so. */
const OWN_PAGES = ['index.html', 'public/index.html', 'src/index.html'];

function parsedManifest(pkgRaw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(pkgRaw);
    return 'object' === typeof parsed && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether a package with a dev script has a page. Asked of the same detector the plan uses, so
 * "is this the app" and "which framework is it" cannot disagree about what a UI dependency is.
 */
function hasPage(dir: string, pkgRaw: string, io: Pick<InitIo, 'exists'>): boolean {
  const found = detect({
    pkg: parsedManifest(pkgRaw),
    configFiles: new Set(),
    lockfiles: new Set(),
  });
  if (Framework.HTML !== found.framework || UiLibrary.UNKNOWN !== found.uiLibrary) return true;
  return OWN_PAGES.some((page) => io.exists(`${dir}/${page}`));
}

function appSignal(dir: string, io: Pick<InitIo, 'exists' | 'readFile'>): AppSignal {
  const pkgRaw = io.readFile(`${dir}/${PACKAGE_JSON}`);
  if (null === pkgRaw) return AppSignal.NONE;
  const configs = [
    ...VITE_CONFIG_CANDIDATES,
    ...ELECTRON_VITE_CONFIG_CANDIDATES,
    ...NEXT_CONFIG_CANDIDATES,
  ];
  if (configs.some((c) => io.exists(`${dir}/${c}`))) return AppSignal.UI;
  // `next.config` is optional in Next, so the dependency list is the other half of the signal.
  if (APP_DEPS.some((d) => pkgRaw.includes(`"${d}"`))) return AppSignal.UI;
  // And the honest third: an app somebody can SERVE. Asking only for a bundler missed every app
  // built on anything else — Remix, Astro, a plain node server — and in a monorepo missing it means
  // init never redirects, wires the ROOT, and reports ✓ for files nothing compiles.
  //
  // A monorepo root has no dev script by design, and a package that can only be BUILT is not the app
  // somebody is working in, so this stays a filter rather than matching every directory.
  if (!hasDevScript(pkgRaw)) return AppSignal.NONE;
  // But a dev script alone is also what an API package has, and counting it made every workspace
  // with a backend beside its web app "ambiguous" (#1148): the root refused, and its hint named the
  // backend. A package with a dev script and no page is only a candidate when nothing else is.
  return hasPage(dir, pkgRaw, io) ? AppSignal.UI : AppSignal.SERVED;
}

/**
 * Whether `dir` is itself an app with a page: what the daemon asks before wiring a folder unasked,
 * so a library or API package it happens to run in is left alone.
 */
export function isWebApp(dir: string, io: Pick<InitIo, 'exists' | 'readFile'>): boolean {
  return AppSignal.UI === appSignal(dir, io);
}

/**
 * App directories under a workspace root.
 *
 * Running `reticle init` at the repo root is what people actually do, and in a monorepo the app is a
 * directory down — so init detected "no framework", printed a wall of manual HTML instructions, and
 * would have installed the SDK into the ROOT package.json. It already walks UP for the lockfile, so
 * it knows it is in a workspace; this is the matching walk DOWN.
 */
export function findWorkspaceApps(io: Pick<InitIo, 'exists' | 'readFile' | 'listDirs'>): string[] {
  const found: string[] = [];
  // A workspace DECLARES its packages; `['apps','packages']` was a guess that missed a real repo
  // with three Next apps at web/, admin/ and space/ — and missing them meant init ran against the
  // root and reported ✓ for a file Next never compiles. See workspace-apps.
  const pkgRaw = io.readFile(PACKAGE_JSON);
  let pkgWorkspaces: unknown;
  try {
    const parsed: unknown = null === pkgRaw ? undefined : JSON.parse(pkgRaw);
    pkgWorkspaces =
      'object' === typeof parsed && parsed !== null
        ? (parsed as { workspaces?: unknown }).workspaces
        : undefined;
  } catch {
    pkgWorkspaces = undefined;
  }
  const parents = workspaceParents({
    ...(null === io.readFile(PNPM_WORKSPACE)
      ? {}
      : { pnpmWorkspace: io.readFile(PNPM_WORKSPACE) ?? '' }),
    ...(pkgWorkspaces === undefined ? {} : { pkgWorkspaces }),
    topLevelDirs: io.listDirs('.'),
  });
  // A declared parent can itself BE the app (`workspaces: ["web"]`), so check both the directory and
  // its children rather than assuming one level of nesting.
  const served: string[] = [];
  const consider = (dir: string): void => {
    const signal = appSignal(dir, io);
    if (AppSignal.UI === signal) found.push(dir);
    if (AppSignal.SERVED === signal) served.push(dir);
  };
  for (const parent of parents) {
    consider(parent);
    for (const name of io.listDirs(parent)) consider(`${parent}/${name}`);
  }
  // A backend is still the app when it is the only thing that can be served — a server-rendered
  // app is exactly that — so it is demoted, never dropped.
  return [...new Set(found.length > 0 ? found : served)];
}

/**
 * Every package directory the workspace declares or holds, app-shaped or not.
 *
 * For the questions discovery's filter must not answer — "which package does the root config name"
 * is about identity, and a package `--app` wired is the app whether or not it looks like one.
 */
export function workspacePackageDirs(io: Pick<InitIo, 'readFile' | 'listDirs'>): string[] {
  const pkgRaw = io.readFile(PACKAGE_JSON);
  const pnpmWorkspace = io.readFile(PNPM_WORKSPACE);
  const parents = workspaceParents({
    ...(null === pnpmWorkspace ? {} : { pnpmWorkspace }),
    ...(null === pkgRaw ? {} : { pkgWorkspaces: parsedManifest(pkgRaw)['workspaces'] }),
    topLevelDirs: io.listDirs('.'),
  });
  return [...new Set(parents.flatMap((p) => [p, ...io.listDirs(p).map((n) => `${p}/${n}`)]))];
}

/** How far up `init` looks for the workspace a package belongs to. Deeper than any real layout. */
const MAX_WORKSPACE_DEPTH = 8;

/**
 * The workspace root that DECLARES `cwd` as one of its packages, or undefined.
 *
 * `init` run inside `apps/web` wrote `.reticle.json` there only, and `reticle mcp` finds that file by
 * walking UP from where the agent stands — so an agent opened at the repo root never found it, fell
 * back to the default port, and drove whichever daemon was there. `init --app apps/web` run from the
 * root writes the root pointer and the agent files at the root; this is what lets a run from inside
 * the app arrive at the same state.
 *
 * Only the NEAREST workspace root is asked, and only its declaration counts: a directory that merely
 * sits under a repo with a package.json is not that repo's app, and guessing it is would write
 * config into a stranger's root.
 */
export function enclosingWorkspaceRoot(
  cwd: string,
  io: Pick<InitIo, 'readFile'>,
): string | undefined {
  let dir = dirname(cwd);
  for (let depth = 0; depth < MAX_WORKSPACE_DEPTH; depth++) {
    const pnpmWorkspace = io.readFile(join(dir, PNPM_WORKSPACE));
    const pkgRaw = io.readFile(join(dir, PACKAGE_JSON));
    const pkgWorkspaces = null === pkgRaw ? undefined : parsedManifest(pkgRaw)['workspaces'];
    if (null !== pnpmWorkspace || pkgWorkspaces !== undefined) {
      const declared = workspaceParents({
        ...(null === pnpmWorkspace ? {} : { pnpmWorkspace }),
        ...(pkgWorkspaces === undefined ? {} : { pkgWorkspaces }),
      });
      const rel = relative(dir, cwd).split(sep).join('/');
      const member = declared.some((base) => rel === base || dirname(rel) === base);
      return member ? dir : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

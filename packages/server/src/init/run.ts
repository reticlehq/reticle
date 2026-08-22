/**
 * The impure shell for `reticle init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */

import { dirname, join } from 'node:path';
import { noPackageJsonMessage } from './non-js-project.js';
import { spanSync } from '../trace.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { projectIdOf, rememberProjectOnDisk } from '../project/remember-project.js';
import { detect, Framework, namesAPackageManager, type DetectInput, UiLibrary } from './detect.js';
import { wasMcpRegistered } from './mcp-registered.js';
import { pickAstroHost } from './astro-host.js';
import { workspaceParents } from './workspace-apps.js';
import { chooseWorkspaceApp } from './app-choice.js';
import { isConnectStep } from './connect-steps.js';
import { CLI, CURSOR_RULE_PATH, RETICLE_MD_PATH } from './agent-rules.js';
import { CRA_ENV_PATH } from './cra.js';

/** CRA's bundled entry, in the order create-react-app itself generates them. */
const CRA_ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js'];

function craEntryOf(io: InitIo): { path: string; source: string } | null {
  for (const path of CRA_ENTRY_CANDIDATES) {
    const source = io.readFile(path);
    if (source !== null) return { path, source };
  }
  return null;
}

/**
 * The daemon's pairing token, for the one stack that cannot read it at build time.
 *
 * Every other framework's snippet reads this file in Node when the dev server starts, so the token
 * is never written into the project. CRA bundles browser code and inlines only REACT_APP_*, so it
 * has to be materialised into .env.development.local — which CRA's own template gitignores.
 */
function readPairingToken(): string {
  try {
    return readFileSync(join(homedir(), '.reticle', 'pairing-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
import {
  DEPS_TARGET,
  RETICLE_CONFIG_FILE,
  frameworkPackages,
  MCP_TARGET,
  buildPlan,
  StepStatus,
  type Plan,
  type PlanInput,
} from './plan.js';
import { claudeAvailableProbe, claudeExistsProbe } from './mcp.js';
import { reticleDevLocation } from './next-patch.js';
import { scanTestids, storeHints, scanStores } from './capabilities.js';
import { CURSOR_DIR_RELPATH, CURSOR_MCP_RELPATH } from './cursor.js';
import { fileBackedClients, clientMarkerRelPath, ConfigScope, McpClient } from './mcp-clients.js';
import { deriveProjectId, packageName } from './project-id.js';
import { VITE_DEV_MODULE_PATH, connectArgWithToken, staticPageSnippet } from './snippets.js';
import { CLAUDE_COMMAND_PATH, CURSOR_COMMAND_PATH } from './slash-command.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { InitFailure, reportInitOutcome } from '../telemetry/init-telemetry.js';
import type { InitOutcome } from '@reticlehq/core';

/** Lockfile basenames, in package-manager preference order (mirrors detect.ts). */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
] as const;

/**
 * Resolve the lockfiles set used to pick the package manager. A lockfile in the project root wins;
 * otherwise we walk UP the directory tree (monorepos keep the lockfile at the workspace root, not in
 * each package) so `reticle init` in a sub-package suggests `pnpm add` instead of defaulting to `npm i`.
 *
 * The walk is skipped when the project has its own installed tree, because an INHERITED lockfile is
 * weaker evidence than a `node_modules` sitting right there — the ancestor describes the workspace,
 * the tree describes THIS package. Reported from the field: `init` in a `frontend/` app installed
 * with npm emitted `pnpm add -D` off a repo-root `pnpm-lock.yaml`, pnpm was not on PATH, and the
 * failed install took every downstream wiring step with it. A LOCAL lockfile still wins over the
 * tree — it is a deliberate statement about this package, not an inheritance.
 */
export function resolveLockfiles(
  rootFiles: ReadonlySet<string>,
  cwd: string,
  io: Pick<InitIo, 'exists'>,
  nodeModulesMarkers: ReadonlySet<string> = new Set(),
): Set<string> {
  const set = new Set(rootFiles);
  if (LOCKFILE_NAMES.some((name) => set.has(name))) return set; // local lockfile is authoritative
  if (namesAPackageManager(nodeModulesMarkers)) return set;
  let dir = cwd;
  for (let depth = 0; depth < 50; depth++) {
    for (const name of LOCKFILE_NAMES) {
      if (io.exists(join(dir, name))) {
        set.add(name);
        return set;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return set;
}

const PACKAGE_JSON = 'package.json';
const NODE_MODULES_DIR = 'node_modules';
/**
 * Root-layout candidates, App Router only. `--src-dir` apps keep theirs under `src/app`, and the
 * ReticleDev component has to land NEXT TO the layout or the relative import it generates is dead.
 */
const NEXT_LAYOUT_CANDIDATES = [
  'app/layout.tsx',
  'app/layout.jsx',
  'app/layout.js',
  'src/app/layout.tsx',
  'src/app/layout.jsx',
  'src/app/layout.js',
];
/**
 * Pages Router mount points, checked only when there is no App Router layout. A Pages app has no
 * `app/` directory at all, so writing the component there produced a file nothing imported.
 */
const NEXT_PAGES_APP_CANDIDATES = [
  'pages/_app.tsx',
  'pages/_app.jsx',
  'pages/_app.js',
  'src/pages/_app.tsx',
  'src/pages/_app.jsx',
  'src/pages/_app.js',
];
const SVELTEKIT_HOOKS = 'src/hooks.client.ts';
const SOURCE_FILE = /\.(tsx|jsx|ts|js|svelte|vue|astro)$/;
/** Files read for the testid scan. A capabilities block is a hint; reading a whole repo for it is not. */
const MAX_SCANNED_FILES = 200;
/** Directories that never hold the app's own source, and are expensive or misleading to read. */
const NOT_SOURCE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'public',
  'static',
  '.next',
  '.svelte-kit',
  '.nuxt',
]);
/** How far below the app root to look. Deep enough for `modules/users/UserList.tsx`, not a repo crawl. */
const MAX_SCAN_DEPTH = 5;

/**
 * Read a bounded set of the app's source files, for the `data-testid` scan.
 *
 * This used to walk the fixed list `src, src/components, src/pages, app, components`. Reported from
 * the field (#318) by a repo whose app is at `src/admin`: the scan read directories that were not
 * the app's and correctly reported finding nothing in them, so `init` said "no data-testid values
 * yet" about an app with several — which makes an agent go and write the ones already there. That
 * list had already grown once for a `frontend/` app, and a third report of the same shape is what
 * says the answer is not another name in a list. So: walk the app root, bounded by depth and by the
 * same file cap as before.
 */
function readSourceFiles(io: InitIo): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const read = (path: string): void => {
    const content = io.readFile(path);
    if (content !== null) out.push({ path, source: content });
  };
  for (const name of io.rootFiles()) {
    if (out.length >= MAX_SCANNED_FILES) return out;
    if (SOURCE_FILE.test(name)) read(name);
  }
  const walk = (dir: string, depth: number): void => {
    for (const name of io.listFiles(dir)) {
      if (out.length >= MAX_SCANNED_FILES) return;
      if (SOURCE_FILE.test(name)) read(`${dir}/${name}`);
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const sub of io.listDirs(dir)) {
      if (out.length >= MAX_SCANNED_FILES) return;
      if (sub.startsWith('.') || NOT_SOURCE_DIRS.has(sub)) continue;
      walk(`${dir}/${sub}`, depth + 1);
    }
  };
  for (const dir of io.listDirs('.')) {
    if (out.length >= MAX_SCANNED_FILES) return out;
    if (dir.startsWith('.') || NOT_SOURCE_DIRS.has(dir)) continue;
    walk(dir, 1);
  }
  return out;
}

/** Direct dependency names, for naming the state libraries an app actually has. */
function dependencyNames(pkg: unknown): Set<string> {
  const p = (pkg ?? {}) as Record<string, Record<string, string> | undefined>;
  return new Set([
    ...Object.keys(p['dependencies'] ?? {}),
    ...Object.keys(p['devDependencies'] ?? {}),
  ]);
}
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];
const ASTRO_CONFIG_CANDIDATES = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.cjs',
];
/** Where a conventional Astro app keeps the layout every page wraps itself in. */
const ASTRO_LAYOUTS_DIR = 'src/layouts';
/** Also searched: an app with no layouts directory renders the document straight from a page. */
const ASTRO_PAGES_DIR = 'src/pages';
const NEXT_CONFIG_CANDIDATES = [
  'next.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.cjs',
];

export interface InitOptions {
  cwd: string;
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
  /**
   * Which app in a monorepo to wire, when several are found. Without it `init` refuses to guess, and
   * "re-run inside the one you want" is not an instruction a script or an agent can follow.
   */
  app?: string;
  /** Set on the recursive call after a workspace redirect, so the search happens at most once. */
  redirected?: boolean;
  /**
   * Where the human ran the command, carried across a workspace redirect.
   *
   * The agent rule and `/reticle` command files are read by the AGENT, whose session runs where the
   * human started it — the repo root. Writing them beside the app instead is how a repo with its app
   * at `src/admin` ended up with no `/reticle` at all (#318).
   */
  agentRoot?: string;
  /**
   * Hand the telemetry outcome back rather than emitting it here.
   *
   * `init` now stays to watch for an app to connect, and whether it saw one belongs on the SAME
   * `init_completed` event — the funnel it exists to measure would be double-counted by a second
   * emit and unjoinable as a second event kind. Only the CLI sets this; every other caller keeps
   * today's fire-and-forget behaviour, so no path loses its event by forgetting to report.
   */
  deferOutcome?: boolean;
}

export interface InitIo {
  /** Returns file content or null if it does not exist. Path is project-relative or absolute. */
  readFile(relPath: string): string | null;
  /** Writes content, creating parent directories. Path is project-relative or absolute. */
  writeFile(relPath: string, content: string): void;
  exists(relPath: string): boolean;
  /** The user's home directory (for global agent config like ~/.cursor/mcp.json). */
  homeDir(): string;
  /** Absolute path of the directory `init` is running in — the project's own root. */
  cwd(): string;
  /** Basenames present in the project root. */
  rootFiles(): readonly string[];
  /** Subdirectory names inside a project-relative directory; empty when it isn't one. */
  listDirs(relPath: string): readonly string[];
  /** File (non-directory) basenames inside a project-relative directory, including dotfiles. */
  listFiles(relPath: string): readonly string[];
  /** The same IO re-rooted at a project-relative subdirectory (used for the workspace redirect). */
  scoped(relPath: string): InitIo;
  /** Runs a subprocess to completion (inherits stdio); returns true on exit code 0. */
  exec(command: string, args: readonly string[]): boolean;
  /** Runs a subprocess quietly (no stdio) for a yes/no check; returns true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
  print(line: string): void;
}

export interface InitResult {
  ok: boolean;
  applied: number;
  manual: number;
  /**
   * The event body this run would report, handed to the caller instead of emitted, when
   * `deferOutcome` is set. Absent on a dry run and on the exits that report for themselves.
   */
  outcome?: InitOutcome;
}

/**
 * `⚠` means WORK LEFT TO DO and nothing else — it is what an agent (and the release gate) counts to
 * decide whether the install finished. A notice gets its own mark so "steps remaining" can reach zero
 * on a working install that happens to be on an ungated stack.
 */
/**
 * A step's status AFTER the run, which is what actually happened to it.
 *
 * `report` applies the same downgrade when printing: a step that failed or was skipped is shown as
 * MANUAL whatever it planned to be. Reading the planned status alone would say a step applied when
 * the run had already given up on it.
 */
function resolvedStatus(
  plan: { steps: readonly { target: string; status: StepStatus }[] },
  target: string,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): StepStatus | undefined {
  const step = plan.steps.find((s) => s.target === target);
  if (step === undefined) return undefined;
  if (failed.has(target) || skipped.has(target)) return StepStatus.MANUAL;
  return step.status;
}

const STATUS_SYMBOL: Record<StepStatus, string> = {
  [StepStatus.APPLY]: '✓',
  [StepStatus.MANUAL]: '⚠',
  [StepStatus.ALREADY]: '·',
  [StepStatus.SKIP]: '–',
  [StepStatus.NOTICE]: 'ℹ',
};

function firstPresent(files: ReadonlySet<string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (files.has(c)) return c;
  return null;
}

/**
 * The directory the human's agent runs in, when it is not the app's directory.
 *
 * `undefined` for a single-package repo, which keeps every agent-file path project-relative exactly
 * as it was — the two roots are the same there, which is why writing them beside the app went
 * unnoticed until a repo with its app at `src/admin` reported it.
 */
function agentRootOf(options: InitOptions): string | undefined {
  const root = options.agentRoot;
  return root === undefined || root === options.cwd ? undefined : root;
}

function gatherPlanInput(options: InitOptions, io: InitIo, pkgRaw: string): PlanInput {
  const pkg: unknown = JSON.parse(pkgRaw);
  // Stable identity derived from the app's package.json name + root, so it survives port changes.
  const projectId = deriveProjectId(packageName(pkg), options.cwd);
  const rootFiles = new Set(io.rootFiles());
  const nodeModulesMarkers = new Set(io.listFiles('node_modules'));
  const detectInput: DetectInput = {
    pkg: 'object' === typeof pkg && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    // Walk up for the lockfile so a monorepo sub-package picks the workspace's package manager —
    // unless this package's own installed tree already answers it, which outranks an inherited one.
    lockfiles: resolveLockfiles(rootFiles, options.cwd, io, nodeModulesMarkers),
    // An already-installed tree names its own manager, which matters when no lockfile is committed.
    nodeModulesMarkers,
  };
  const detection = detect(detectInput);

  const vitePath = firstPresent(rootFiles, VITE_CONFIG_CANDIDATES);
  const viteSource = null === vitePath ? null : io.readFile(vitePath);
  const viteConfig =
    vitePath !== null && viteSource !== null ? { path: vitePath, source: viteSource } : null;

  // Global MCP registration targets each agent that's present: Claude via its CLI, Cursor via its
  // global config file. Only probe when the MCP step is in play.
  const availableProbe = claudeAvailableProbe();
  const claudeCli = options.mcp ? io.probe(availableProbe.command, availableProbe.args) : false;
  const existsProbe = claudeExistsProbe();
  const mcpExists = claudeCli ? io.probe(existsProbe.command, existsProbe.args) : false;

  // join(), not a literal '/': this path is checked and WRITTEN on the user's machine, and a
  // backslash platform silently misses the config it is meant to find.
  const cursorDir = join(io.homeDir(), CURSOR_DIR_RELPATH);
  const cursorConfigPath = join(io.homeDir(), CURSOR_MCP_RELPATH);
  // Cursor is "present" if its global config directory exists OR the project carries a `.cursor/`.
  // The directory alone missed a real case: Cursor installed with a FRESH profile has not written
  // ~/.cursor yet, so a user who had it open got no Cursor step and no message about one. A
  // project-level .cursor/ is unambiguous evidence somebody uses it here.
  const cursorPresent = options.mcp && (io.exists(cursorDir) || io.exists(CURSOR_DIR_RELPATH));
  const cursorConfig = cursorPresent ? io.readFile(cursorConfigPath) : null;

  // Every OTHER MCP client this machine shows evidence of. Conservative and one-directional: we
  // write into a config a client ALREADY has, and never create ~/.gemini or ~/.codeium for somebody
  // who does not use them. Cursor and Claude are handled above by their own steps.
  const detectedClients = options.mcp
    ? fileBackedClients()
        .filter((spec) => spec.id !== McpClient.CURSOR)
        .map((spec) => {
          const marker = clientMarkerRelPath(spec);
          const absolute =
            spec.scope === ConfigScope.HOME ? join(io.homeDir(), spec.relPath) : spec.relPath;
          const markerPath = spec.scope === ConfigScope.HOME ? join(io.homeDir(), marker) : marker;
          if (!io.exists(markerPath)) return null;
          return {
            id: spec.id,
            configPath: absolute,
            // io.readFile passes absolute paths through unchanged, so one call covers both scopes.
            existing: io.readFile(absolute),
          };
        })
        .filter((entry) => entry !== null)
    : [];

  const astroPath = firstPresent(rootFiles, ASTRO_CONFIG_CANDIDATES);
  const astroSource = null === astroPath ? null : io.readFile(astroPath);
  // Which file owns the DOCUMENT, not how many files sit in a directory. The old rule ("exactly one
  // .astro in src/layouts") fired on neither real Astro app: one has no layouts directory and
  // renders from src/pages/index.astro, the other has three files there of which two are partials.
  // `</body>` is the discriminator — see astro-host.
  const astroCandidates = [ASTRO_LAYOUTS_DIR, ASTRO_PAGES_DIR].flatMap((dir) =>
    io
      .listFiles(dir)
      .filter((f) => f.endsWith('.astro'))
      .map((f) => ({ path: `${dir}/${f}`, source: io.readFile(`${dir}/${f}`) }))
      .filter((c): c is { path: string; source: string } => c.source !== null),
  );
  const astroHost = pickAstroHost(astroCandidates);
  const layoutRelPath = astroHost?.path ?? null;
  const astroLayoutSource = astroHost?.source ?? null;

  const nextConfigFile = firstPresent(rootFiles, NEXT_CONFIG_CANDIDATES);
  // App Router first; a Pages Router app has no layout, and its mount point is pages/_app.
  const layoutPath =
    NEXT_LAYOUT_CANDIDATES.find((p) => io.exists(p)) ??
    NEXT_PAGES_APP_CANDIDATES.find((p) => io.exists(p)) ??
    null;
  const layoutSource = null === layoutPath ? null : io.readFile(layoutPath);
  // Where the component goes depends on WHICH router mounts it: `pages/` routes on presence, so a
  // component there becomes a broken route; `app/` routes on filename, so a sibling is inert.
  const devLocation = reticleDevLocation(layoutPath ?? 'app/layout.tsx', detection.typescript);
  // Read once: both the testid scan and the store scan want the same bounded set of files.
  const sourceFiles = readSourceFiles(io);
  const agentRoot = agentRootOf(options);
  const agentFile = (relPath: string): string =>
    agentRoot === undefined ? relPath : join(agentRoot, relPath);

  return {
    detection,
    claudeCli,
    mcpExists,
    cursorPresent,
    detectedClients,
    cursorProjectPresent: io.exists(CURSOR_DIR_RELPATH),
    cursorConfig,
    cursorConfigPath,
    viteConfig,
    astroConfig:
      astroPath !== null && astroSource !== null ? { path: astroPath, source: astroSource } : null,
    astroLayout:
      layoutRelPath !== null && astroLayoutSource !== null
        ? { path: layoutRelPath, source: astroLayoutSource }
        : null,
    nextConfigFile,
    nextConfigSource: null === nextConfigFile ? null : io.readFile(nextConfigFile),
    nextLayout:
      layoutPath !== null && layoutSource !== null
        ? { path: layoutPath, source: layoutSource }
        : null,
    // Capabilities: scanned, never asked for. Bounded — a hint for the agent, not a repo index.
    testids: scanTestids(sourceFiles.map((f) => f.source)),
    storeHints: storeHints(dependencyNames(pkg)),
    foundStores: scanStores(sourceFiles, dependencyNames(pkg)),
    nextFoundStores: scanStores(sourceFiles, dependencyNames(pkg), dirname(devLocation.path)),
    viteDevModuleExists: io.exists(VITE_DEV_MODULE_PATH),
    nextReticleDevPath: devLocation.path,
    nextReticleDevImport: devLocation.importSpecifier,
    nextReticleDevExists: io.exists(devLocation.path),
    svelteKitHooksExists: io.exists(SVELTEKIT_HOOKS),
    craEntry: craEntryOf(io),
    craEnv: io.readFile(CRA_ENV_PATH),
    pairingToken: readPairingToken(),
    reticleConfigExists: io.exists(RETICLE_CONFIG_FILE),
    // The CONTENT, so a config that exists can be checked rather than trusted — a `"port"` set to
    // the app's own dev-server port used to survive every re-run of `init`.
    reticleConfigSource: io.readFile(RETICLE_CONFIG_FILE),
    // Read the agent instruction files so the rule merge stays idempotent across re-runs — from the
    // agent's own root, or the merge would idempotently check a file it is not going to write.
    claudeMdContent: io.readFile(agentFile('CLAUDE.md')),
    agentsMdContent: io.readFile(agentFile('AGENTS.md')),
    reticleMdContent: io.readFile(agentFile(RETICLE_MD_PATH)),
    cursorRuleContent: io.readFile(agentFile(CURSOR_RULE_PATH)),
    claudeCommandContent: io.readFile(agentFile(CLAUDE_COMMAND_PATH)),
    cursorCommandContent: io.readFile(agentFile(CURSOR_COMMAND_PATH)),
    ...(agentRoot === undefined
      ? {}
      : {
          agentFileRoot: agentRoot,
          // The config the AGENT's cwd already has, if any — see agentRootConfigStep.
          agentRootConfigSource: io.readFile(agentFile(RETICLE_CONFIG_FILE)),
        }),
    options: {
      port: options.port,
      mcp: options.mcp,
      install: options.install,
      projectId,
      // The SDK must match the CLI asking for it — see pinnedPackages.
      sdkVersion: SERVER_VERSION,
    },
  };
}

/** Where workspace tooling conventionally puts packages. */
/** pnpm's workspace declaration, read when present — it is authoritative about where packages live. */
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
/** Deps that mark a directory as a runnable web app even when it has no bundler config file. */
const APP_DEPS = ['next', 'vite'] as const;

function looksLikeApp(dir: string, io: Pick<InitIo, 'exists' | 'readFile'>): boolean {
  const pkgRaw = io.readFile(`${dir}/${PACKAGE_JSON}`);
  if (null === pkgRaw) return false;
  const configs = [...VITE_CONFIG_CANDIDATES, ...NEXT_CONFIG_CANDIDATES];
  if (configs.some((c) => io.exists(`${dir}/${c}`))) return true;
  // `next.config` is optional in Next, so the dependency list is the other half of the signal.
  return APP_DEPS.some((d) => pkgRaw.includes(`"${d}"`));
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
  for (const parent of parents) {
    if (looksLikeApp(parent, io)) found.push(parent);
    for (const name of io.listDirs(parent)) {
      const dir = `${parent}/${name}`;
      if (looksLikeApp(dir, io)) found.push(dir);
    }
  }
  return [...new Set(found)];
}

/**
 * The standing ask, printed at the end of every `init`.
 *
 * Addressed to the agent as much as the human: whichever of them just ran this command is the one
 * holding the experience, and neither has a Reticle tool surface to file through at this point.
 *
 * Printed by the `runInit` wrapper, NOT by `report()` — see the comment there for why, and for how
 * the workspace redirect is kept from asking twice.
 */
export const FEEDBACK_HINT =
  'Anything wrong, missing, or awkward — in this setup or in Reticle itself? Tell us; it is the ' +
  'one thing that decides what gets fixed:\n' +
  `  ${CLI} feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"   (agents)\n` +
  `  ${CLI} feedback "what worked, what didn't"   (humans)`;

function devServerRestart(framework: Framework): string {
  if (framework === Framework.NEXT) return 'Restart `next dev`';
  if (framework === Framework.VITE) return 'Restart `vite`';
  if (framework === Framework.ASTRO) return 'Restart `astro dev`';
  if (framework === Framework.SVELTEKIT) return 'Restart your dev server (`npm run dev`)';
  return 'Reload your app on localhost';
}

/**
 * The last two lines a user reads, and the order matters.
 *
 * This used to say only "Restart <dev server>, then ask your agent: List Reticle sessions" — and
 * asking the agent was the one thing that could not work yet. `init` registers the MCP server, but
 * an agent client reads its tool list when it STARTS and never re-reads it, so the session that
 * just ran `init` has no `reticle_*` tools however clean the install was. The user follows the
 * instruction, the agent answers "unknown tool", and the obvious conclusion is that the install
 * failed.
 *
 * So the reload is named FIRST, before the sentence that depends on it. Omitted entirely when this
 * run did not register MCP (`--no-mcp`), where it would be advice about something we did not do.
 */
export function restartHint(framework: Framework, mcpStatus: StepStatus | undefined): string {
  const dev = `${devServerRestart(framework)}.`;
  // NAME THE COMMAND THAT PROVES IT, not one that merely asks.
  //
  // `init` writes files and stops; the install is not finished until an app carrying the SDK has
  // actually dialled the daemon, and nothing here confirmed that. The field shape is unambiguous:
  // people complete the agent half, never complete the app half, and keep a daemon running for
  // weeks with nothing to drive — so this is the last instruction most of them read.
  //
  // "Ask your agent: List Reticle sessions" asks a question whose failure is a dead end. `reticle
  // status` ANSWERS it: as of 2.7.0 it reports the session, or says why there is none — no app
  // running, an app running that never dialled us, a tab that closed — with the fix for each.
  const prove =
    'Then run `npx @reticlehq/server status` — it confirms the app connected, or says exactly why ' +
    'it has not.';
  // Nothing registered this run (`--no-mcp`, or a client that needs a manual edit): a restart picks
  // up nothing, so advice about one would be advice about something we did not do.
  if (!wasMcpRegistered(mcpStatus)) return `${dev} ${prove}`;
  // ALREADY: the tools are reachable RIGHT NOW, and this is the branch that used to lie.
  //
  // `wasMcpRegistered` is true for both APPLY and ALREADY, which is correct for the funnel field it
  // was written for and wrong here, because the two cases have opposite answers to "must anybody
  // restart". Every second project on a machine, and every Claude Code plugin install, took the
  // APPLY text: "restart your agent — the tools only appear after that". An agent reads this AFTER
  // whatever its skill file said, and it describes the output in front of it, so it wins. The agent
  // stops with the project wired and nothing driven, which is the exact failure the install path
  // exists to prevent, caused by the install path itself.
  if (mcpStatus === StepStatus.ALREADY) {
    return (
      `${dev}\n` +
      'The Reticle MCP server was already registered on this machine, so there is no restart to do ' +
      'and the tools are available now.\n' +
      `${prove}\n` +
      'Once it shows a session, drive a flow — that is the install finished. Carry straight on; ' +
      'nothing here is waiting on a human.'
    );
  }
  return (
    `${dev}\n` +
    'Then restart your agent so it picks up the new MCP server — restart Claude Code, reload the ' +
    'window in Cursor, or hit Start in `.vscode/mcp.json` in VS Code.\n' +
    'The tools only appear after that: your agent read its server list before Reticle existed, ' +
    'and no slash command re-reads it (`/mcp` manages servers already loaded, so it cannot pick ' +
    'up a new one). This is once per machine — Reticle is registered globally, so every later ' +
    'project starts with the tools already there.\n' +
    `${prove}\n` +
    'Once it shows a session, ask your agent to drive a flow — that is the install finished.'
  );
}

const SKIPPED_DETAIL =
  'skipped — the dependency install above failed, and wiring the app to a package that is not ' +
  'installed stops it booting. Run that install, then re-run `reticle init`.';

function report(
  plan: Plan,
  dryRun: boolean,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  degraded: ReadonlyMap<string, string>,
  io: InitIo,
  projectDir: string,
  agentRoot: string | undefined,
): InitResult {
  io.print(dryRun ? 'reticle init (dry run, no files written)' : 'reticle init');
  // Every path below is printed RELATIVE, and until now nothing said what to. Reported from the
  // field as "[✓] Reticle config → .reticle.json" followed by the file not being there: the app was
  // in `frontend/`, init redirected into it, and the report's `.reticle.json` was true about a
  // directory the reader was not standing in. One line makes every path in the report unambiguous.
  io.print(`  in ${projectDir}`);
  // The agent files go where the AGENT is, which after a redirect is not where the app is. Said out
  // loud because it changes where `/reticle` will exist, and a reader who assumes one directory for
  // everything goes looking in the wrong one (#318).
  if (agentRoot !== undefined)
    io.print(`  agent files in ${agentRoot} (where /reticle will exist)`);
  io.print('');
  let applied = 0;
  let manual = 0;
  // A ⚠ on a CONNECT step is a guaranteed failure, not a caveat: nothing performs the manual step, so
  // the app never dials the daemon and every tool answers "no browser session connected". `ok` was
  // hardcoded true, so a run that could not possibly work reported success.
  let connectPending = false;
  for (const s of plan.steps) {
    // A side effect that failed to apply is reported as a manual step with its fallback command.
    const note = degraded.get(s.target);
    if (note !== undefined) {
      // Applied, but not the way it was asked for. A NOTICE, not work — the install did happen.
      io.print(`  [${STATUS_SYMBOL[StepStatus.NOTICE]}] ${s.title} → ${s.target}`);
      for (const line of note.split('\n')) io.print(`      ${line}`);
      applied++;
      continue;
    }
    const downgraded = failed.has(s.target) || skipped.has(s.target);
    const status = downgraded ? StepStatus.MANUAL : s.status;
    const detail = skipped.has(s.target)
      ? SKIPPED_DETAIL
      : downgraded && s.exec !== undefined
        ? `step failed — run manually: ${s.exec.fallback}`
        : s.detail;
    io.print(`  [${STATUS_SYMBOL[status]}] ${s.title} → ${s.target}`);
    if (status === StepStatus.APPLY) applied++;
    if (status === StepStatus.MANUAL || status === StepStatus.NOTICE) {
      // A notice prints in full like a manual step — it is worth reading — but is NOT counted as work.
      if (status === StepStatus.MANUAL) {
        manual++;
        if (isConnectStep(s.title)) connectPending = true;
      }
      for (const line of detail.split('\n')) io.print(`      ${line}`);
    } else if (detail.length > 0) {
      io.print(`      ${detail}`);
    }
  }
  io.print('');
  if (connectPending) {
    io.print(
      'This app will NOT connect until the ⚠ step above is done by hand — Reticle tools will report ' +
        '"no browser session connected" until then. Everything else is already in place.',
    );
    io.print('');
  }
  io.print(restartHint(plan.framework, resolvedStatus(plan, MCP_TARGET, failed, skipped)));
  return { ok: !connectPending, applied, manual };
}

/**
 * Perform the apply-step side effects; return the targets whose side effect failed.
 *
 * Steps run in plan order, which puts the dependency install BEFORE everything that imports what it
 * installs. If it fails, the wiring is skipped rather than applied: patching `next.config.ts` to
 * import a `@reticlehq/next` that was never installed takes the dev server down with
 * MODULE_NOT_FOUND, so the app stops booting *because* Reticle was installed. A skipped step is a
 * message; a half-wired app is a broken project.
 */
/**
 * Are the SDK packages actually on disk, whatever the install step reported?
 *
 * `dependsOnInstall` exists to stop init writing a `next.config.ts` that imports a package which is
 * not there — that took a dev server down once, and installing Reticle must never be why an app
 * stops booting. The invariant it protects is "the import RESOLVES", but it was gated on "our
 * install subprocess exited 0", and those come apart in exactly the situation the failure creates:
 * init tells the user to install by hand, they do, they re-run init, the install step fails again
 * (wrong package manager, not on PATH) and every wiring step is skipped a second time. Reported from
 * a Next 16 app where npm had already installed both packages successfully — leaving an init that
 * could not be retried into working, which is the shape this guard was written to prevent.
 *
 * Reading node_modules answers the real question and costs one `exists` call per package.
 */
function sdkPackagesPresent(
  framework: Framework,
  uiLibrary: UiLibrary,
  io: Pick<InitIo, 'exists'>,
): boolean {
  const packages = frameworkPackages(framework, uiLibrary);
  return (
    packages.length > 0 &&
    packages.every((p) => io.exists(`${NODE_MODULES_DIR}/${p}/${PACKAGE_JSON}`))
  );
}

function applyEffects(
  plan: Plan,
  io: InitIo,
): { failed: Set<string>; skipped: Set<string>; degraded: Map<string, string> } {
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const degraded = new Map<string, string>();
  let installFailed = false;
  for (const s of plan.steps) {
    if (s.status !== StepStatus.APPLY) continue;
    if (installFailed && true === s.dependsOnInstall) {
      skipped.add(s.target);
      continue;
    }
    const write = s.write;
    if (write !== undefined) {
      // Confirm the EFFECT, not the intention. Reported from the field (#160): init printed
      // `[✓] Reticle config → .reticle.json` and the file was not there afterward. Nothing checked —
      // no arrangement of the filesystem (a read-only mount, a full disk, an antivirus quarantining
      // a new dotfile) could have turned that tick into anything else. A checkmark that cannot fail
      // is decoration, and this one is the first thing a new user reads. Same shape as #139.
      const wrote = spanSync('init.write', { target: s.target, path: write.path }, () => {
        try {
          io.writeFile(write.path, write.content);
        } catch {
          return false; // a throw is the loud version of the same failure
        }
        return io.exists(write.path);
      });
      if (!wrote) {
        failed.add(s.target);
        continue; // do not run this step's exec against a file that is not there
      }
    }
    // Bound once so the traced call cannot need a `?? ''` fallback — a default there would turn a
    // narrowing mistake into an empty command that silently "succeeds".
    const exec = s.exec;
    // Per-step, because the interesting part of init's wall-clock is WHICH step spent it: a
    // package-manager install and a `claude mcp add` are both subprocesses, and one of them being
    // slow is a completely different problem from the other.
    if (
      exec !== undefined &&
      !spanSync('init.exec', { target: s.target, command: exec.command }, () =>
        io.exec(exec.command, exec.args),
      )
    ) {
      // A weaker second attempt beats no install at all — but only when it is REPORTED, because the
      // thing it gives up is the version pin that keeps SDK and daemon in step.
      //
      // Traced separately, and it is the reason init can take twice as long as it looks like it
      // should: this is a SECOND full package-manager run, and until it had its own span 1.6 of
      // init's 2.3 seconds simply vanished — the span above accounted for the first attempt and
      // nothing accounted for this one.
      const retry = s.retry;
      if (
        retry !== undefined &&
        spanSync('init.exec.retry', { target: s.target, command: retry.command }, () =>
          io.exec(retry.command, retry.args),
        )
      ) {
        degraded.set(s.target, retry.note);
        continue;
      }
      failed.add(s.target);
      // A failed install only blocks the wiring when the packages are genuinely ABSENT. See
      // sdkPackagesPresent: the guard protects "the import resolves", not "our subprocess exited 0".
      if (s.target === DEPS_TARGET && !sdkPackagesPresent(plan.framework, plan.uiLibrary, io))
        installFailed = true;
    }
  }
  // Where this project lives, remembered for a daemon that will be started somewhere else.
  //
  // Deliberately AFTER the loop and unconditional on which steps ran: most init runs report "already
  // wired", and a re-run in a re-cloned or moved checkout is exactly when the remembered path has
  // gone stale — so the run that would otherwise be a no-op is the one that repairs the entry. The
  // return value is ignored on purpose; this is a cache, and a read-only home directory must not
  // turn a wired project into a failed init.
  const projectId = projectIdOf(io.readFile(RETICLE_CONFIG_FILE));
  if (projectId !== undefined) {
    rememberProjectOnDisk(io, projectId, io.cwd(), Date.now());
  }
  return { failed, skipped, degraded };
}

/**
 * Which STEP failed, from the step targets — not from an error string, which would carry paths.
 *
 * The distinction that matters: a dependency install failing is a machine/network problem (offline,
 * a locked registry, a broken package manager), while MCP registration failing means the `claude` CLI
 * is missing or refused. Two completely different fixes, and until now both were simply "init didn't
 * work" with nothing to tell them apart.
 */
function classifyInitFailure(failed: ReadonlySet<string>): string {
  if (failed.has(DEPS_TARGET)) return InitFailure.DEPENDENCY_INSTALL;
  if (failed.has(MCP_TARGET)) return InitFailure.MCP_REGISTRATION;
  return InitFailure.OTHER;
}

const AMBIGUOUS_HEADER =
  'Several apps found in this workspace. Re-run `reticle init` inside the one you want:';

/**
 * When the current directory is a workspace root with no app of its own, wire the app instead of the
 * root. One candidate is wired silently (there is nothing to ask about); several are listed, because
 * guessing which app someone meant is worse than one line of output.
 * Returns null when there is nothing to redirect to — the caller then proceeds here as before.
 */
function redirectToWorkspaceApp(
  options: InitOptions,
  io: InitIo,
  pkgRaw: string,
): InitResult | null {
  if (true === options.redirected) return null;
  const pkg: unknown = JSON.parse(pkgRaw);
  const rootFiles = new Set(io.rootFiles());
  const here = detect({
    pkg: 'object' === typeof pkg && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    lockfiles: new Set(),
  });
  if (here.framework !== Framework.HTML) return null; // this directory IS the app

  const apps = findWorkspaceApps(io);
  // An explicitly named app answers the ambiguity. Refusing to guess is right, but "re-run inside the
  // one you want" is not something a script, a CI step, or an agent that cannot change directory can
  // act on — so the refusal was a dead end for exactly the callers most likely to hit it.
  const chosen = chooseWorkspaceApp(options.app, apps);
  if (!chosen.ok) {
    io.print(chosen.message);
    return { ok: false, applied: 0, manual: 1 };
  }
  const target = chosen.app ?? (1 === apps.length ? apps[0] : undefined);
  if (target === undefined) {
    if (0 === apps.length) return null; // not a workspace — fall through to the normal HTML plan
    io.print(AMBIGUOUS_HEADER);
    for (const a of apps) io.print(`  ${a}`);
    io.print('');
    io.print(`Or name one without changing directory:  reticle init --app ${apps[0] ?? '<dir>'}`);
    return { ok: false, applied: 0, manual: apps.length };
  }
  io.print(`No app in this directory — wiring ${target} instead.`);
  io.print('');
  return runInit(
    {
      ...options,
      cwd: join(options.cwd, target),
      redirected: true,
      // Where the human is STANDING, kept across the redirect: their agent session runs here, so
      // this is the only place a `/reticle` command file can be found by it.
      agentRoot: options.agentRoot ?? options.cwd,
    },
    io.scoped(target),
  );
}

export function runInit(options: InitOptions, io: InitIo): InitResult {
  const result = runInitSteps(options, io);
  // The ask goes here, not in report(): report() is only the success-shaped path, and the exits that
  // matter most are the ones that never reach it — no package.json, an ambiguous workspace — where
  // setup died before anything ran and the person holding the report has the least to go on. This
  // wrapper is the one point every exit passes through.
  //
  // `redirected` is what keeps it to ONE print: wiring an app in a monorepo re-enters runInit for the
  // chosen directory, and the inner call must not ask again.
  if (true !== options.redirected) {
    io.print('');
    io.print(FEEDBACK_HINT);
  }
  return result;
}

function runInitSteps(options: InitOptions, io: InitIo): InitResult {
  const pkgRaw = io.readFile(PACKAGE_JSON);
  // Look for the app BEFORE concluding there isn't one.
  //
  // A root with no package.json is not a dead end — it is the ordinary shape of a repo whose app
  // lives one directory down (`frontend/`, `web/`, `client/`) with no manifest at the top. Bailing
  // first made that repo un-instrumentable: `reticle init` said "No package.json found", and
  // `--app frontend`, the flag that exists for exactly this, was never read because the bail came
  // first. Reported twice by the same user, who tried the documented workaround and hit the same
  // wall. Discovery already handles the case (it scans top-level directories, not just declared
  // workspaces); it was simply unreachable.
  //
  // `'{}'` because the redirect only needs the manifest to ask "is THIS directory the app", and a
  // directory with no package.json is definitively not.
  const redirectedEarly = redirectToWorkspaceApp(options, io, pkgRaw ?? '{}');
  if (redirectedEarly !== null) return redirectedEarly;
  if (null === pkgRaw) {
    io.print(
      // Two genuinely different situations used to share one sentence: a JS developer in the wrong
      // directory, and a project that is not JavaScript at all. The second reads the old wording as
      // a path problem and goes looking for a directory that cannot exist — reported from a
      // Streamlit app, where the search continued into hunting for a browser bundle to inject by
      // hand before the real answer surfaced.
      noPackageJsonMessage((file) => io.exists(join(options.cwd, file))),
    );
    // The message says "add the snippet below". Print the snippet, or the message is the same
    // broken promise in the other direction. `connectArg` carries the port; there is no projectId
    // to bake, because a projectId is derived from the package.json that does not exist here.
    io.print(staticPageSnippet(connectArgWithToken(options.port, undefined, readPairingToken())));
    // The onboarding funnel had NO instrumentation, so a setup that died here was indistinguishable
    // from someone who never ran the command — the two failure modes with the most different fixes.
    reportInitOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
    return { ok: false, applied: 0, manual: 0 };
  }

  // Init is the flow a user experiences the wait of personally, and the fixture gate measures it at
  // 1–6s per app with no explanation of the spread. These three spans split that number into detect
  // (filesystem probing), plan (pure), and apply (writes + package-manager and CLI subprocesses).
  const plan = spanSync('init.plan', {}, () => buildPlan(gatherPlanInput(options, io, pkgRaw)));
  const effects = options.dryRun
    ? { failed: new Set<string>(), skipped: new Set<string>(), degraded: new Map<string, string>() }
    : spanSync('init.apply', { steps: plan.steps.length }, () => applyEffects(plan, io));
  const { failed, skipped, degraded } = effects;
  const result = report(
    plan,
    options.dryRun,
    failed,
    skipped,
    degraded,
    io,
    options.cwd,
    agentRootOf(options),
  );
  // A dry run is a preview, not an outcome — reporting it would inflate both success and failure.
  if (options.dryRun) return result;
  const outcome: InitOutcome = {
    ok: result.ok,
    ...(result.ok ? {} : { reason: classifyInitFailure(failed) }),
    stack: plan.framework,
    // The step's REAL final status, not the absence of a failure — see mcp-registered.
    mcpRegistered: wasMcpRegistered(resolvedStatus(plan, MCP_TARGET, failed, skipped)),
  };
  if (true === options.deferOutcome) return { ...result, outcome };
  reportInitOutcome(outcome);
  return result;
}

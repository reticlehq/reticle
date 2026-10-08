/**
 * The impure shell for `reticle init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */
import { OnboardingPhase, OnboardingStepStatus } from '@reticlehq/core/telemetry';
import { detectMcpClients } from './register/detect-clients.js';
import type { InitOptions, InitIo, InitResult, InitContext } from './run-types.js';
export type { InitOptions, InitIo, InitResult } from './run-types.js';

import { dirname, join } from 'node:path';
import { CONTAINER_MARKERS, runsDevServer } from './diagnose/containerised-dev-server.js';
import { explainInstallFailure } from './diagnose/install-retries.js';
import { CSP_FILES } from './diagnose/csp-doctor.js';
import { preflight } from './plan/preflight.js';
import { devCommandFrom, devScriptBody } from './detect/dev-script.js';
import { restartHint, FEEDBACK_HINT } from './diagnose/closing-hint.js';
import { projectIdOf, rememberProjectOnDisk } from './project/remember-project.js';
import {
  ANGULAR_WORKSPACE_FILE,
  detect,
  FORGE_RENDERER_CONFIGS,
  Framework,
  type DetectInput,
  type PackageManager,
} from './detect/detect.js';
import { ANGULAR_PROXY_PATH, angularEntry } from './patch/angular.js';
import {
  HTML_INDEX_PATH,
  STATIC_GITIGNORE_PATH,
  STATIC_TOKEN_MODULE,
} from './patch/static-page.js';
import { initWithoutPackageJson } from './no-package-json.js';
import { sdkPackagesDeclared, sdkPackagesPresent } from './sdk-packages.js';
import { wasMcpRegistered } from './register/mcp-registered.js';
import { pickAstroHost } from './patch/astro-host.js';
import {
  ELECTRON_VITE_CONFIG_CANDIDATES,
  NEXT_CONFIG_CANDIDATES,
  PACKAGE_JSON,
  VITE_CONFIG_CANDIDATES,
} from './detect/workspace-apps.js';
import { redirectToWorkspaceApp } from './detect/workspace-redirect.js';
import { enclosingWorkspaceRoot } from './detect/workspace-apps.js';
import { isConnectStep } from './plan/connect-steps.js';
import { CURSOR_RULE_PATH, RETICLE_MD_PATH } from './project/agent-rules.js';
import { CLAUDE_SETTINGS_PATH } from './plan/stop-hook-step.js';
import { CRA_ENV_PATH } from './patch/cra.js';
import { NEXT_LAYOUT_CANDIDATES, NEXT_PAGES_APP_CANDIDATES } from './patch/next-patch.js';
import { formatGeneratedSource } from './patch/format-generated.js';
import { tanstackStartConnectPath } from './patch/tanstack-start.js';
import { installedViteMajor } from './patch/vite-owning-config.js';

/** CRA's bundled entry, in the order create-react-app itself generates them. */
const CRA_ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js'];
/** Preview snippets must not mint a real machine credential or imply this token is usable. */
const DRY_RUN_PAIRING_TOKEN = 'DRY_RUN_TOKEN_NOT_FOR_USE';

function craEntryOf(io: InitIo): { path: string; source: string } | null {
  for (const path of CRA_ENTRY_CANDIDATES) {
    const source = io.readFile(path);
    if (source !== null) return { path, source };
  }
  return null;
}

import {
  DEPS_TARGET,
  RETICLE_CONFIG_FILE,
  MCP_TARGET,
  buildPlan,
  StepStatus,
  type Plan,
  type PlanInput,
} from './plan/plan.js';
import { claudeAvailableProbe, claudeHasReticle } from './register/mcp.js';
import { reticleDevLocation } from './patch/next-patch.js';
import { scanTestids, storeHints, scanStores } from './detect/capabilities.js';
import { CLAUDE_PROJECT_CONFIG, CURSOR_PROJECT_MARKER } from './register/mcp-clients.js';
import { deriveProjectId, packageName } from './project/project-id.js';
import {
  VITE_DEV_MODULE_PATH,
  ELECTRON_VITE_DEV_MODULE_PATH,
  nuxtPluginPath,
} from './patch/snippets.js';
import { NUXT_CONFIG_CANDIDATES } from './patch/nuxt-patch.js';
import { CLAUDE_COMMAND_PATH, CURSOR_COMMAND_PATH } from './register/slash-command.js';
import { RETICLE_VERSION } from './version.js';
import { InitFailure } from './diagnose/init-failure.js';
import type { InitOutcome } from '@reticlehq/core/telemetry';

import { resolveLockfiles } from './detect/lockfiles.js';
// Re-exported: it moved to its own module, and every existing importer says `run.js`.
export { resolveLockfiles };

const SVELTEKIT_HOOKS = 'src/hooks.client.ts';
const REACT_ROUTER_ENTRY = 'app/entry.client.tsx';
const TANSTACK_START_ROOT_CANDIDATES = [
  'src/routes/__root.tsx',
  'src/routes/__root.jsx',
  'app/routes/__root.tsx',
  'app/routes/__root.jsx',
];
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
 * says the answer is not another name in a list. So: walk the app root, bounded by depth and by a
 * file count.
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
/** electron-vite and the unbundled Electron layouts this repo already ships. */
const ELECTRON_MAIN_SOURCES = [
  'src/main/index.ts',
  'src/main/index.js',
  'src/main/index.mts',
  'src/main/index.mjs',
  'electron/main.cjs',
  'electron/main.js',
  'electron/main.ts',
  'src/main.ts',
  'src/main.js',
];
const ELECTRON_PRELOAD_SOURCES = [
  'src/preload/index.ts',
  'src/preload/index.js',
  'src/preload/index.mts',
  'src/preload/index.mjs',
  'electron/preload.cjs',
  'electron/preload.js',
  'electron/preload.ts',
  'src/preload.ts',
  'src/preload.js',
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

/** Every client registration row is titled `MCP server (<client>)`; the closing hint names the unfinished ones. */
const MCP_CLIENT_TITLE_PREFIX = 'MCP server (';

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

function firstReadable(
  io: Pick<InitIo, 'readFile'>,
  candidates: readonly string[],
): { path: string; source: string } | null {
  for (const path of candidates) {
    const source = io.readFile(path);
    if (source !== null) return { path, source };
  }
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

/** What the Angular steps read: the workspace file, the entry it names, and our proxy module. */
function angularInputs(
  io: InitIo,
): Pick<PlanInput, 'angularWorkspace' | 'angularEntry' | 'angularProxySource'> {
  const workspace = io.readFile(ANGULAR_WORKSPACE_FILE);
  const entryPath = angularEntry(workspace);
  const entry = io.readFile(entryPath);
  return {
    angularWorkspace:
      null === workspace ? null : { path: ANGULAR_WORKSPACE_FILE, source: workspace },
    angularEntry: null === entry ? null : { path: entryPath, source: entry },
    angularProxySource: io.readFile(ANGULAR_PROXY_PATH),
  };
}

function gatherPlanInput(options: InitOptions, io: InitIo, pkg: unknown): PlanInput {
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
  // Forge has no `vite.config.*`; its renderer config IS the Vite config the plugin belongs in, and
  // handing it over under that name is what lets the ordinary Vite patcher do the work.
  const vitePath = firstPresent(
    rootFiles,
    Framework.ELECTRON_FORGE === detection.framework
      ? FORGE_RENDERER_CONFIGS
      : VITE_CONFIG_CANDIDATES,
  );
  const viteSource = null === vitePath ? null : io.readFile(vitePath);
  const viteConfig =
    vitePath !== null && viteSource !== null ? { path: vitePath, source: viteSource } : null;

  const electronVitePath = firstPresent(rootFiles, ELECTRON_VITE_CONFIG_CANDIDATES);
  const electronViteSource = null === electronVitePath ? null : io.readFile(electronVitePath);
  const electronViteConfig =
    electronVitePath !== null && electronViteSource !== null
      ? { path: electronVitePath, source: electronViteSource }
      : null;
  const electronMain = firstReadable(io, ELECTRON_MAIN_SOURCES);
  const electronPreload = firstReadable(io, ELECTRON_PRELOAD_SOURCES);

  // Global MCP registration targets each agent that's present: Claude via its CLI, Cursor via its
  // global config file. Only probe when the MCP step is in play.
  const availableProbe = claudeAvailableProbe();
  const claudeCli = options.mcp ? io.probe(availableProbe.command, availableProbe.args) : false;
  // Read from Claude's config, never `claude mcp get`: that launches the server — see claudeHasReticle.
  const mcpExists = claudeCli ? claudeHasReticle(io, io.cwd()) : false;

  // Every MCP client this machine shows evidence of. Conservative and one-directional: we write
  // into a config a client ALREADY has, and never create ~/.gemini or ~/.codeium for somebody who
  // does not use them.
  const detectedClients = options.mcp ? detectMcpClients(io) : [];

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

  const nuxtConfigPath = firstPresent(rootFiles, NUXT_CONFIG_CANDIDATES);
  const nuxtConfigSource = null === nuxtConfigPath ? null : io.readFile(nuxtConfigPath);
  // Nuxt 4's default srcDir is `app/`, Nuxt 3's is the root — and a plugin written into the
  // directory Nuxt does not scan is never registered, silently.
  const nuxtHasAppDir = io.listDirs('.').includes('app');

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

  const cspSources: Record<string, string | undefined> = {};
  for (const file of CSP_FILES) {
    const source = io.readFile(file);
    if (null !== source) cspSources[file] = source;
  }

  return {
    detection,
    captureBodies: options.captureBodies,
    hooks: options.hooks,
    cspSources,
    claudeCli,
    mcpExists,
    insideClaudeCode: io.host.insideClaudeCode(),
    claudeProjectConfig: options.mcp ? io.readFile(agentFile(CLAUDE_PROJECT_CONFIG)) : undefined,
    platform: process.platform,
    detectedClients,
    cursorProjectPresent: io.exists(CURSOR_PROJECT_MARKER),
    // Looked for beside the app AND one level up, because the app is routinely a subdirectory of the
    // repo that containerises it — `frontend/` under a root `docker-compose.yml` is the shape this
    // came from. Only the first match is reported; the note is the same whichever file found it.
    ...(() => {
      // Only a file that RUNS the dev server: a production-only image is the common case, and
      // React Router's template ships one. See runsDevServer.
      const devScript = devScriptBody(pkg);
      const marker = CONTAINER_MARKERS.find((name) =>
        [name, join('..', name)].some((path) => {
          const content = io.readFile(path);
          return null !== content && runsDevServer(name, content, devScript);
        }),
      );
      return marker === undefined ? {} : { containerMarker: marker };
    })(),
    viteConfig,
    electronViteConfig,
    electronPreload,
    electronMain,
    astroConfig:
      astroPath !== null && astroSource !== null ? { path: astroPath, source: astroSource } : null,
    astroLayout:
      layoutRelPath !== null && astroLayoutSource !== null
        ? { path: layoutRelPath, source: astroLayoutSource }
        : null,
    astroEnvDts: io.readFile('src/env.d.ts'),
    astroReticleDev: io.readFile('src/components/ReticleDev.ts'),
    nextConfigFile,
    nextConfigSource: null === nextConfigFile ? null : io.readFile(nextConfigFile),
    nextLayout:
      layoutPath !== null && layoutSource !== null
        ? { path: layoutPath, source: layoutSource }
        : null,
    // Capabilities: scanned, never asked for. Bounded — a hint for the agent, not a repo index.
    testids: scanTestids(sourceFiles.map((f) => f.source)),
    storeHints: storeHints(dependencyNames(pkg), sourceFiles),
    foundStores: scanStores(sourceFiles, dependencyNames(pkg)),
    nextFoundStores: scanStores(sourceFiles, dependencyNames(pkg), dirname(devLocation.path)),
    viteDevModuleExists: io.exists(
      detection.framework === Framework.ELECTRON_VITE
        ? ELECTRON_VITE_DEV_MODULE_PATH
        : VITE_DEV_MODULE_PATH,
    ),
    nextReticleDevPath: devLocation.path,
    nextReticleDevImport: devLocation.importSpecifier,
    nextReticleDevExists: io.exists(devLocation.path),
    nextReticleDevSource: io.readFile(devLocation.path),
    svelteKitHooksExists: io.exists(SVELTEKIT_HOOKS),
    svelteKitHooksSource: io.readFile(SVELTEKIT_HOOKS),
    reactRouterEntryExists: io.exists(REACT_ROUTER_ENTRY),
    // The SOURCE, so an entry the app already owns is ADDED TO rather than replaced — it is an
    // override of React Router's default, and everything in it is load-bearing.
    reactRouterEntrySource: io.readFile(REACT_ROUTER_ENTRY),
    nuxtConfig:
      nuxtConfigPath !== null && nuxtConfigSource !== null
        ? { path: nuxtConfigPath, source: nuxtConfigSource }
        : null,
    nuxtHasAppDir,
    viteMajor: installedViteMajor(io, detectInput.pkg),
    nuxtPluginExists: io.exists(nuxtPluginPath(nuxtHasAppDir)),
    nuxtPluginSource: io.readFile(nuxtPluginPath(nuxtHasAppDir)),
    ...(() => {
      const root = TANSTACK_START_ROOT_CANDIDATES.find((file) => io.exists(file));
      return root === undefined
        ? {}
        : {
            tanstackStartRoot: root,
            tanstackStartRootSource: io.readFile(root),
            tanstackStartConnectExists: io.exists(tanstackStartConnectPath(root)),
            tanstackStartConnectSource: io.readFile(tanstackStartConnectPath(root)),
          };
    })(),
    ...(Framework.ANGULAR === detection.framework ? angularInputs(io) : {}),
    ...(Framework.HTML === detection.framework
      ? {
          htmlIndexSource: io.readFile(HTML_INDEX_PATH),
          htmlLocalSources: {
            [STATIC_TOKEN_MODULE]: io.readFile(STATIC_TOKEN_MODULE),
            [STATIC_GITIGNORE_PATH]: io.readFile(STATIC_GITIGNORE_PATH),
          },
        }
      : {}),
    craEntry: craEntryOf(io),
    craEnv: io.readFile(CRA_ENV_PATH),
    pairingToken: options.dryRun ? DRY_RUN_PAIRING_TOKEN : io.host.pairingToken(),
    installSource: io.host.installSource(),
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
    // Read only to MERGE into: the settings file is the user's, and other tools write in it too.
    claudeSettingsContent:
      true === options.hooks ? io.readFile(agentFile(CLAUDE_SETTINGS_PATH)) : undefined,
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
      sdkVersion: RETICLE_VERSION,
    },
  };
}

/** Where workspace tooling conventionally puts packages. */
/** pnpm's workspace declaration, read when present — it is authoritative about where packages live. */

const SKIPPED_DETAIL =
  'skipped — the dependency install above failed, and wiring the app to a package that is not ' +
  'installed stops it booting. Run that install, then re-run `reticle init`.';

function report(
  plan: Plan,
  dryRun: boolean,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  degraded: ReadonlyMap<string, string>,
  why: ReadonlyMap<string, string>,
  io: InitIo,
  projectDir: string,
  agentRoot: string | undefined,
  /** The project's own dev command, so the closing line names what a human would type. */
  devCommand: string | undefined,
  /**
   * Whether this run continues into the phases that boot the app and drive it.
   *
   * The closing hint tells the reader to restart their dev server and then drive a flow. When those
   * are the very next things this command does, printing them is worse than noise: it is an
   * instruction to do by hand what is about to happen automatically, three lines before it happens.
   */
  continuesToRuntime = false,
): InitResult {
  io.print(dryRun ? 'reticle init (dry run, no files written)' : 'reticle init');
  /*
   * The escape hatches, named by the command that needs them, at the moment it needs them.
   *
   * `--dry-run`, `--app` and `--no-mcp` all exist and all work, and they were discoverable only
   * from `--help`. A prospective user's agent refused to run this at all — correctly, since it was
   * being asked to let a third-party package edit a build config and register itself with every
   * agent on the machine, and nothing it could see offered a way to look first. It had already
   * decided by the time `--help` would have told it.
   *
   * On the REAL run only. In a dry run the reader has already found the flag.
   */
  if (!dryRun) {
    io.print(
      '  --dry-run previews · --app <dir> picks the app · --no-mcp skips agent registration',
    );
  }
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
  // Other clients' registrations the run left for the reader, named for the closing hint.
  const manualClients: string[] = [];
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
        ? (why.get(s.target) ?? `step failed — run manually: ${s.exec.fallback}`)
        : s.detail;
    io.print(`  [${STATUS_SYMBOL[status]}] ${s.title} → ${s.target}`);
    if (status === StepStatus.APPLY) applied++;
    if (status === StepStatus.MANUAL || status === StepStatus.NOTICE) {
      // A notice prints in full like a manual step — it is worth reading — but is NOT counted as work.
      if (status === StepStatus.MANUAL) {
        manual++;
        if (isConnectStep(s.title)) connectPending = true;
        if (s.target !== MCP_TARGET && s.title.startsWith(MCP_CLIENT_TITLE_PREFIX)) {
          manualClients.push(s.title);
        }
      }
      for (const line of detail.split('\n')) io.print(`      ${line}`);
    }
    // Everything else gets its row and nothing more. The detail on a step that needs no decision
    // restates its own title — "reticle already registered with Cursor" under
    // `[·] MCP server (Cursor)` — and a measured Vite first run spent twelve of its forty-six lines
    // that way, six tool names deep, before saying anything about the reader's own app.
    //
    // The ROW stays on every step: `apps/e2e/install-gate.mjs` reads `[mark] title → target` out of
    // this report and diffs the shape against a recorded baseline, so a row that stopped printing
    // would take that guard down with it while looking like tidying.
  }
  io.print('');
  if (connectPending) {
    io.print(
      'This app will NOT connect until the ⚠ step above is done by hand — Reticle tools will report ' +
        '"no browser session connected" until then. Everything else is already in place.',
    );
    io.print('');
  }
  const mcpStatus = resolvedStatus(plan, MCP_TARGET, failed, skipped);
  if (!continuesToRuntime) {
    io.print(restartHint(mcpStatus, devCommand, manualClients));
  }
  // Carried out even when the hint above was printed, because the RUNTIME path needs the same fact
  // and could not reach it: `restartHint` is only printed when this run stops at the files, and the
  // full run -- the one the installer sends everybody to -- ended by telling an agent to call
  // `reticle_act_and_wait` in a session whose tool list was read before Reticle existed.
  return {
    ok: !connectPending,
    applied,
    manual,
    ...(StepStatus.APPLY === mcpStatus ? { mcpNewlyRegistered: true } : {}),
  };
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
function applyEffects(plan: Plan, io: InitIo, packageManager: PackageManager): Effects {
  const why = new Map<string, string>();
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
      const wrote = io.host.span('init.write', { target: s.target, path: write.path }, () => {
        try {
          // Format connect modules with the project's Prettier when present (#684) — a clean
          // install must not fail the project's own lint on a file we just wrote.
          const content = formatGeneratedSource(write.content, write.path, io.cwd());
          io.writeFile(write.path, content);
        } catch {
          return false; // a throw is the loud version of the same failure
        }
        if (!io.exists(write.path)) return false;
        // A PATCH is only applied if what it was supposed to add is there to read back. A generated
        // file we own is proved by existing; a config we edited is not, and a patcher that quietly
        // no-ops returns the source unchanged, which writes and exists exactly like a success.
        const expect = write.expect;
        if (undefined === expect) return true;
        const after = io.readFile(write.path) ?? '';
        return expect.every((needle) => after.includes(needle));
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
      !io.host.span('init.exec', { target: s.target, command: exec.command }, () =>
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
      // Walked in order, cheapest concession first, and STOPS at the first success — a later,
      // weaker attempt must never run once an earlier one has already produced a working tree.
      const succeeded = (s.retries ?? []).find((retry) =>
        io.host.span('init.exec.retry', { target: s.target, command: retry.command }, () =>
          io.exec(retry.command, retry.args),
        ),
      );
      if (succeeded !== undefined) {
        degraded.set(s.target, succeeded.note);
        continue;
      }
      // Verify, don't re-run: give the install step itself the same sdkPackagesPresent benefit
      // already given to the wiring it gates below (#683) — but only when package.json DECLARES
      // them. Reported from a Tauri + Next app: `pnpm add` died on ERR_PNPM_UNEXPECTED_STORE, the
      // packages happened to resolve, init printed success, and the manifest never gained them.
      const present =
        s.target === DEPS_TARGET && sdkPackagesPresent(plan.framework, plan.uiLibrary, io);
      if (present && sdkPackagesDeclared(plan.framework, plan.uiLibrary, io)) continue;
      failed.add(s.target);
      // A failed install only blocks the wiring when the packages are genuinely ABSENT. See
      // sdkPackagesPresent: the guard protects "the import resolves", not "our subprocess exited 0".
      if (s.target === DEPS_TARGET) {
        installFailed = !present;
        const explained = explainInstallFailure(io, packageManager, exec, s.detail);
        if (explained !== undefined) why.set(s.target, explained);
      }
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
  return { failed, skipped, degraded, why };
}

/** What applying the plan did, per step target. `why` carries a failure's real cause when known. */
interface Effects {
  failed: Set<string>;
  skipped: Set<string>;
  degraded: Map<string, string>;
  why: Map<string, string>;
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

/**
 * Where the agent stands when `init` runs inside a workspace package: the workspace root.
 *
 * The same answer `--app` from the root already gives (see enterApp), so both routes into one app
 * leave the root in one state — a pointer config and the agent files an agent opened there reads.
 */
function withWorkspaceRoot(options: InitOptions, io: InitIo): InitOptions {
  if (options.agentRoot !== undefined || true === options.redirected) return options;
  const root = enclosingWorkspaceRoot(options.cwd, io);
  return root === undefined ? options : { ...options, agentRoot: root };
}

export function runInit(options: InitOptions, io: InitIo): InitResult {
  const result = runInitSteps(withWorkspaceRoot(options, io), io);
  // The ask goes here, not in report(): report() is only the success-shaped path, and the exits that
  // matter most are the ones that never reach it — no package.json, an ambiguous workspace — where
  // setup died before anything ran and the person holding the report has the least to go on. This
  // wrapper is the one point every exit passes through.
  //
  // `redirected` is what keeps it to ONE print: wiring an app in a monorepo re-enters runInit for the
  // chosen directory, and the inner call must not ask again.
  //
  // And not when the runtime follows: it asks once it has finished, as the last thing printed,
  // rather than here in the middle, before the dev server has even started.
  if (true !== options.redirected && true !== options.continuesToRuntime) {
    io.print('');
    io.print(FEEDBACK_HINT);
  }
  return result;
}

/**
 * The manifest, parsed once, or the reason it could not be.
 *
 * It used to be parsed in three places from the same raw string, and two of them were unguarded —
 * so `reticle init` on a `package.json` with a trailing comma died with a raw `SyntaxError` and a
 * stack through `redirectToWorkspaceApp`. A stack trace in front of a user is a bug whatever caused
 * it, and this one lands on the very first thing the command does, before it has said anything.
 *
 * `setup/reticle.mjs` has always got this right ("… is not valid JSON (…). Fix it and re-run"). The
 * shipped CLI did not, which is the shape of every divergence between the two: the prototype refuses
 * politely, `init` throws. Parsing once at the single point the file enters means no later caller
 * CAN reintroduce it — a guard per call site would have been three guards and a fourth one waiting.
 */
function readManifest(io: InitIo): { pkg: unknown } | { error: string } {
  const raw = io.readFile(PACKAGE_JSON);
  if (null === raw) return { pkg: null };
  try {
    return { pkg: JSON.parse(raw) };
  } catch (err) {
    // First line only: JSON.parse's message carries the offending position, and the rest is noise.
    const detail = String(err instanceof Error ? err.message : err).split('\n')[0] ?? 'unparseable';
    return { error: detail };
  }
}

function runInitSteps(options: InitOptions, io: InitIo): InitResult {
  const manifest = readManifest(io);
  if ('error' in manifest) {
    io.print(
      `${PACKAGE_JSON} is not valid JSON (${manifest.error}). Fix it and re-run — init reads the ` +
        'framework, the dev script and the package manager from it, and will not guess at any of ' +
        'them from a file it cannot read.',
    );
    if (!options.dryRun)
      io.host.reportOutcome({ ok: false, reason: InitFailure.MALFORMED_PACKAGE_JSON });
    return { ok: false, applied: 0, manual: 0 };
  }
  const pkgRaw = manifest.pkg;
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
  const redirectedEarly = redirectToWorkspaceApp(options, io, pkgRaw ?? {}, runInit);
  if (redirectedEarly !== null) return redirectedEarly;
  if (null === pkgRaw) return initWithoutPackageJson(options, io);

  // Init is the flow a user experiences the wait of personally, and the fixture gate measures it at
  // 1–6s per app with no explanation of the spread. These three spans split that number into detect
  // (filesystem probing), plan (pure), and apply (writes + package-manager and CLI subprocesses).
  const planInput = gatherPlanInput(options, io, pkgRaw);

  // Before anything is written, and AFTER detection — the package manager to check is the one init
  // RESOLVED, not a raw lockfile read. An inherited pnpm-lock.yaml at a monorepo root does not mean
  // the app in frontend/ uses pnpm, and checking the file refused a scaffold the install gate proves
  // must succeed. Both conditions make every later phase fail, and each arrives far from its cause
  // when it is not checked here. See preflight.ts.
  const preflightIo = {
    cwd: () => io.cwd(),
    canWrite: () => io.canWrite(),
    probe: (command: string, args: readonly string[]) => io.probe(command, args),
  };
  const resolved = preflight(preflightIo, planInput.detection.packageManager, {
    alreadyServed: options.url !== undefined && '' !== options.url,
  });
  if (resolved.refusal !== undefined) {
    io.print(resolved.refusal);
    if (!options.dryRun) io.host.reportOutcome({ ok: false, reason: InitFailure.PREFLIGHT });
    return { ok: false, applied: 0, manual: 1 };
  }
  // The prefix that can actually run it on THIS machine — `pnpm`, or `corepack pnpm` where preflight
  // just proved only corepack can. Threaded onto detection (never recomputed by `detect`, which is
  // pure and never probes) so the install step, its retries and the dev command all spawn and print
  // the same thing preflight just confirmed works, instead of a bare binary it already ruled out.
  const packageManagerCommand = resolved.command;
  planInput.detection = { ...planInput.detection, packageManagerCommand };
  const plan = io.host.span('init.plan', {}, () => buildPlan(planInput));
  const effects = options.dryRun
    ? { failed: new Set<string>(), skipped: new Set<string>(), degraded: new Map(), why: new Map() }
    : io.host.span('init.apply', { steps: plan.steps.length }, () =>
        applyEffects(plan, io, planInput.detection.packageManager),
      );
  const { failed, skipped, degraded, why } = effects;
  // The project's own dev command, so the closing line names what a human would actually type.
  const devCommand = devCommandFrom(pkgRaw, packageManagerCommand);
  const result = report(
    plan,
    options.dryRun,
    failed,
    skipped,
    degraded,
    why,
    io,
    options.cwd,
    agentRootOf(options),
    devCommand,
    true === options.continuesToRuntime,
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
  const context: InitContext = {
    appDir: options.cwd,
    framework: plan.framework,
    packageManager: planInput.detection.packageManager,
    ...(undefined === devCommand ? {} : { devCommand }),
    ...(true === options.redirected ? { redirectedTo: options.cwd } : {}),
  };
  /*
   * The two INSTALL steps `init` is the only thing that can answer.
   *
   * `mcp_registered` reads the step's REAL resolved status rather than "nothing failed" — the same
   * distinction `mcpRegistered` above already makes, and for the same reason: a step that was
   * SKIPPED never registered anything, and reporting it as success is how a funnel shows an install
   * completing that never gave the agent any tools.
   *
   * `instrumented` is FILES WRITTEN and nothing more. The page still has to load and dial the
   * bridge, which `app_connected` reports minutes later from the daemon — keeping them separate is
   * the whole reason this funnel exists.
   */
  /*
   * REPORTED HERE, not where detection happens, and the reason is a measured one.
   *
   * These are fire-and-forget POSTs. Emitted mid-run, `project_detected` never arrived: the CLI
   * exited before the request landed, exactly as `daemon_stopped` once did microseconds before
   * `process.exit(0)` — the failure the telemetry contract opens with. The steps below survive
   * because init keeps working after them, so the request has time to complete.
   *
   * Grouping them is a workaround and worth naming as one: the real fix is a flush before exit, and
   * until there is one, ANY emit that is not followed by work is a coin toss. Nothing fails loudly
   * when it loses; the data is just quietly absent.
   */
  io.host.reportStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'project_detected',
    status: OnboardingStepStatus.COMPLETED,
    stack: planInput.detection.framework,
  });
  const mcpOk = wasMcpRegistered(resolvedStatus(plan, MCP_TARGET, failed, skipped));
  io.host.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'agents_detected',
    status: OnboardingStepStatus.COMPLETED,
    stack: plan.framework,
  });
  io.host.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'mcp_registered',
    status: mcpOk ? OnboardingStepStatus.COMPLETED : OnboardingStepStatus.SKIPPED,
    stack: plan.framework,
  });
  io.host.reportStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'instrumented',
    status: result.ok ? OnboardingStepStatus.COMPLETED : OnboardingStepStatus.FAILED,
    stack: plan.framework,
    ...(result.ok ? {} : { reason: classifyInitFailure(failed) }),
  });
  // A failed dependency install skipped every wiring step, so there is no instrumented app to boot:
  // without a context the runtime stops at this report, rather than starting the dev server and
  // diagnosing an SDK that was never installed as a dev server that needs restarting.
  const handover = failed.has(DEPS_TARGET) ? {} : { context };
  if (true === options.deferOutcome) return { ...result, ...handover, outcome };
  io.host.reportOutcome(outcome);
  return { ...result, ...handover };
}

/**
 * What `reticle init` reads before it plans: every project file, probe and host answer the pure
 * planner takes, gathered through the injected `InitIo`.
 *
 * Split from `run.ts`, which orchestrates the run (plan, apply, report). This is only the read side,
 * and it writes nothing.
 */
import { detectMcpClients } from './register/detect-clients.js';
import type { InitOptions, InitIo } from './run-types.js';
import { dirname, join } from 'node:path';
import { CONTAINER_MARKERS, runsDevServer } from './diagnose/containerised-dev-server.js';
import { CSP_FILES } from './diagnose/csp-doctor.js';
import { devScriptBody, discoverPlainViteConfig } from './detect/dev-script.js';
import {
  ANGULAR_WORKSPACE_FILE,
  detect,
  FORGE_RENDERER_CONFIGS,
  Framework,
  TSCONFIG_FILE,
  type DetectInput,
} from './detect/detect.js';
import { ANGULAR_PROXY_PATH, angularEntry } from './patch/angular.js';
import {
  HTML_INDEX_PATH,
  STATIC_GITIGNORE_PATH,
  STATIC_TOKEN_MODULE,
} from './patch/static-page.js';
import { pickAstroHost } from './patch/astro-host.js';
import {
  ELECTRON_VITE_CONFIG_CANDIDATES,
  NEXT_CONFIG_CANDIDATES,
  VITE_CONFIG_CANDIDATES,
} from './detect/workspace-apps.js';
import { CURSOR_RULE_PATH, RETICLE_MD_PATH } from './project/agent-rules.js';
import { CLAUDE_SETTINGS_PATH } from './plan/stop-hook-step.js';
import {
  PromptHookAgent,
  promptHookTargets,
  type PromptHookTarget,
} from './register/prompt-hooks.js';
import { CRA_ENV_PATH } from './patch/cra.js';
import { findNextMountFile } from './patch/next-patch.js';
import { tanstackStartConnectPath } from './patch/tanstack-start.js';
import { installedViteMajor } from './patch/vite-owning-config.js';
import { PRETTIERIGNORE_PATH } from './patch/prettier-ignore.js';
import { RETICLE_CONFIG_FILE, type PlanInput } from './plan/plan.js';
import { claudeAvailableProbe, claudeHasReticle, codexAvailableProbe } from './register/mcp.js';
import { nextUsesTypeScript, reticleDevLocation } from './patch/next-patch.js';
import { scanTestids, storeHints, scanStores } from './detect/capabilities.js';
import { CLAUDE_PROJECT_CONFIG, CURSOR_PROJECT_MARKER, McpClient } from './register/mcp-clients.js';
import { deriveProjectId, packageName } from './project/project-id.js';
import {
  VITE_DEV_MODULE_PATH,
  ELECTRON_VITE_DEV_MODULE_PATH,
  nuxtPluginPath,
} from './patch/snippets.js';
import { NUXT_CONFIG_CANDIDATES } from './patch/nuxt-patch.js';
import { CLAUDE_COMMAND_PATH, CURSOR_COMMAND_PATH } from './register/slash-command.js';
import { RETICLE_VERSION } from './version.js';
import { resolveLockfiles } from './detect/lockfiles.js';
import { projectIdOf } from './detect/existing-config.js';

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
/** The files that quote `id` as a whole string literal (see `copiedIdSources`). */
function quoting(
  files: readonly { path: string; source: string }[],
  id: string | undefined,
): { path: string; source: string }[] {
  if (id === undefined) return [];
  return files.filter((f) => ['"', "'", '`'].some((q) => f.source.includes(`${q}${id}${q}`)));
}

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
export function agentRootOf(options: InitOptions): string | undefined {
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

export function gatherPlanInput(options: InitOptions, io: InitIo, pkg: unknown): PlanInput {
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
  const nodeModulesLinked = true === io.isSymlink?.('node_modules');
  // Forge has no `vite.config.*`; its renderer config IS the Vite config the plugin belongs in, and
  // handing it over under that name is what lets the ordinary Vite patcher do the work.
  const plainViteConfig =
    Framework.VITE === detection.framework
      ? discoverPlainViteConfig(io, pkg, rootFiles, VITE_CONFIG_CANDIDATES)
      : undefined;
  const vitePath = firstPresent(
    rootFiles,
    Framework.ELECTRON_FORGE === detection.framework
      ? FORGE_RENDERER_CONFIGS
      : VITE_CONFIG_CANDIDATES,
  );
  const viteSource = null === vitePath ? null : io.readFile(vitePath);
  const viteConfig =
    plainViteConfig === undefined
      ? vitePath !== null && viteSource !== null
        ? { path: vitePath, source: viteSource }
        : null
      : plainViteConfig.config;

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
  // Codex registers through its own CLI when there is one. Asked only after Codex was FOUND: the
  // probe runs a binary, and a machine with no Codex has no business running one.
  const codexProbe = codexAvailableProbe();
  const codexCli = detectedClients.some((client) => McpClient.CODEX === client.id)
    ? io.probe(codexProbe.command, codexProbe.args)
    : false;

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
  // App Router first, route groups included (#1538); a Pages Router app mounts in pages/_app.
  const nextMount = findNextMountFile(io);
  const layoutPath = nextMount.path;
  const layoutSource = null === layoutPath ? null : io.readFile(layoutPath);
  // Where the component goes depends on WHICH router mounts it: `pages/` routes on presence, so a
  // component there becomes a broken route; `app/` routes on filename, so a sibling is inert.
  // And which LANGUAGE it is written in follows Next's rule, not `detection.typescript`: a
  // `typescript` devDependency in a jsconfig app is not a TypeScript project to Next (#1527).
  const devLocation = reticleDevLocation(
    layoutPath ?? 'app/layout.tsx',
    nextUsesTypeScript(layoutPath, rootFiles.has(TSCONFIG_FILE)),
  );
  // Read once: both the testid scan and the store scan want the same bounded set of files.
  const sourceFiles = readSourceFiles(io);
  const copiedId = projectIdOf(io.readFile(RETICLE_CONFIG_FILE));
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
    ...(nodeModulesLinked ? { nodeModulesLinked } : {}),
    captureBodies: options.captureBodies,
    hooks: options.hooks,
    cspSources,
    prettierIgnoreSource: io.readFile(PRETTIERIGNORE_PATH),
    claudeCli,
    mcpExists,
    insideClaudeCode: io.host.insideClaudeCode(),
    claudeProjectConfig: options.mcp ? io.readFile(agentFile(CLAUDE_PROJECT_CONFIG)) : undefined,
    platform: process.platform,
    detectedClients,
    codexCli,
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
    viteConfigCandidates: plainViteConfig?.candidates,
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
    nextLayoutCandidates: nextMount.candidates,
    nextUnmountedLayouts: nextMount.unmounted,
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
    ...(true === options.newId ? { copiedIdSources: quoting(sourceFiles, copiedId) } : {}),
    // Read the agent instruction files so the rule merge stays idempotent across re-runs — from the
    // agent's own root, or the merge would idempotently check a file it is not going to write.
    claudeMdContent: io.readFile(agentFile('CLAUDE.md')),
    agentsMdContent: io.readFile(agentFile('AGENTS.md')),
    reticleMdContent: io.readFile(agentFile(RETICLE_MD_PATH)),
    cursorRuleContent: io.readFile(agentFile(CURSOR_RULE_PATH)),
    claudeCommandContent: io.readFile(agentFile(CLAUDE_COMMAND_PATH)),
    cursorCommandContent: io.readFile(agentFile(CURSOR_COMMAND_PATH)),
    // Read only to MERGE into: the settings file is the user's, and other tools write in it too.
    claudeSettingsContent: io.readFile(agentFile(CLAUDE_SETTINGS_PATH)),
    ...promptHookInput(io, options, claudeCli, agentFile),
    ...((): { hookBin?: string } => {
      const bin = io.host.hookBin?.();
      return bin === undefined ? {} : { hookBin: bin };
    })(),
    ...(agentRoot === undefined
      ? {}
      : {
          agentFileRoot: agentRoot,
          // The config the AGENT's cwd already has, if any — see agentRootConfigStep.
          agentRootConfigSource: io.readFile(agentFile(RETICLE_CONFIG_FILE)),
          agentRootSeveralApps: true === options.severalApps,
        }),
    options: {
      port: options.port,
      mcp: options.mcp,
      install: options.install,
      projectId,
      ...(true === options.newId ? { newId: true } : {}),
      // The SDK must match the CLI asking for it — see pinnedPackages.
      sdkVersion: RETICLE_VERSION,
    },
  };
}

/**
 * Which agents get the prompt-capture hook, and what their configs hold now. Rides with the agent
 * wiring, so `--no-mcp` skips it as it skips the rule files. Claude Code's entry is merged with the
 * other hooks in `.claude/settings.json`, so it is a flag here and not a target.
 */
function promptHookInput(
  io: InitIo,
  options: InitOptions,
  claudeCli: boolean,
  agentFile: (relPath: string) => string,
): { claudePromptHook: boolean; promptHooks: PromptHookTarget[] } {
  if (!options.mcp || false === options.promptCapture) {
    return { claudePromptHook: false, promptHooks: [] };
  }
  const targets = promptHookTargets(io, agentFile('.'), io.homeDir(), claudeCli, join);
  return {
    claudePromptHook: targets.some((t) => PromptHookAgent.CLAUDE_CODE === t.spec.id),
    promptHooks: targets.filter((t) => PromptHookAgent.CLAUDE_CODE !== t.spec.id),
  };
}

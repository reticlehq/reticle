/**
 * Pure framework + toolchain detection for `reticle init`. No filesystem access — callers pass in
 * the parsed package.json and the set of config/lock filenames present in the project root.
 */

export const Framework = {
  NEXT: 'next',
  /**
   * Nuxt owns its own Vite instance and has no `vite.config`, so it used to fall all the way through
   * to HTML — and then be handed a React kit and a connect snippet guarded on
   * `window.location.hostname === 'localhost'`, which cannot work in a Vue app (the guard throws
   * during SSR, and never runs at all on a non-localhost dev host). Detected in its own right so it
   * gets the package and the recipe that actually fit it.
   */
  NUXT: 'nuxt',
  VITE: 'vite',
  /**
   * electron-vite is Vite-based but its config holds three build configs (main/preload/renderer)
   * and only the renderer has a DOM. The generic Vite path patches the FIRST plugins array, which
   * is main's — wiring the SDK where there is no document, and reporting success.
   */
  ELECTRON_VITE: 'electron-vite',
  /**
   * Electron Forge's Vite template. Its Vite config is split three ways (`vite.main.config.*`,
   * `vite.preload.config.*`, `vite.renderer.config.*`) and there is no `vite.config.*` at all, so it
   * used to read as plain Vite with a missing config: a manual step, no preload shim, no capture
   * helper, and a re-run that could never clear the ⚠. Only the renderer config has a document.
   */
  ELECTRON_FORGE: 'electron-forge',
  /**
   * React Router in FRAMEWORK mode (v7's `@react-router/dev`, the successor to Remix).
   *
   * Vite-based, and it renders HTML through its own request handler — so the Vite plugin's
   * `transformIndexHtml` injection never fires and the connect script never reaches the page. It
   * used to fall through to `Framework.VITE`, where `init` wired the plugin, reported every step
   * green, and produced zero sessions: confirmed by a reporter curling the SSR'd HTML (no
   * `reticle-connect` anywhere) with the daemon showing no session for 20+ minutes (#678).
   *
   * The same class as SvelteKit and Astro below, and detected in the same place and for the same
   * reason: a framework that owns its own HTML rendering is invisible to the injection hook.
   *
   * Library mode — `react-router` as a plain dependency with no `@react-router/dev` — is NOT this.
   * That app renders through its own `index.html` and the plugin works, so it stays on the Vite
   * path.
   */
  REACT_ROUTER: 'react-router',
  /**
   * Remix v2 (`@remix-run/dev`) — React Router framework mode under its previous name.
   *
   * On Vite (`vitePlugin` from `@remix-run/dev`) it renders its own HTML exactly as framework mode
   * does, so it needs the same client-entry connect. It used to fall through to `Framework.VITE`:
   * the plugin was wired, every step went green, and the page never connected, because nothing
   * reaches a document Remix SSRs. On the classic compiler (no Vite) there is no plugin to serve the
   * connect module at all, and the plan says so rather than wiring half of it.
   */
  REMIX: 'remix',
  /**
   * TanStack Start SSRs `<html>` from `src/routes/__root.tsx` and never sends Vite's index.html, so
   * the plugin's `transformIndexHtml` injection never fires. It used to fall through to
   * `Framework.VITE`, where `init` wired the plugin, reported every step green ("also injects
   * connect()"), and produced zero sessions — confirmed in the field as many minutes of "still
   * verifying" against a daemon showing none (#773).
   *
   * Keyed on `@tanstack/react-start` or the older `@tanstack/start`, never on
   * `@tanstack/react-query` or `@tanstack/react-router` alone — those are libraries on a Vite SPA
   * whose index.html the plugin does reach. Not `@tanstack/solid-start` either: that would install
   * the React kit into a Solid app.
   */
  TANSTACK_START: 'tanstack-start',
  SVELTEKIT: 'sveltekit',
  ASTRO: 'astro',
  /**
   * Angular CLI. It has no Vite config to patch (the CLI owns its bundler) and no index.html at the
   * root, so it used to fall through to HTML — and be handed the React kit, a ⚠ pointing at a file
   * that does not exist, and two snippets that fail on it.
   */
  ANGULAR: 'angular',
  /** Create React App. No config file exists, so `react-scripts` in the dependencies is the signal. */
  CRA: 'cra',
  HTML: 'html',
} as const;
export type Framework = (typeof Framework)[keyof typeof Framework];

export const PackageManager = {
  PNPM: 'pnpm',
  YARN: 'yarn',
  BUN: 'bun',
  NPM: 'npm',
} as const;
export type PackageManager = (typeof PackageManager)[keyof typeof PackageManager];

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface DetectInput {
  pkg: PackageJsonLike;
  /** Basenames of config files present in the project root (e.g. 'next.config.mjs'). */
  configFiles: ReadonlySet<string>;
  /** Lockfile basenames present in the project root. */
  lockfiles: ReadonlySet<string>;
  /** Marker basenames inside `node_modules` (`.modules.yaml`, `.yarn-state.yml`, …), if installed. */
  nodeModulesMarkers?: ReadonlySet<string>;
}

/**
 * The UI library the app renders with. Detection used to key on "vite is in package.json" and stop
 * there, so a Vue or Preact app got `@reticlehq/react` installed and an all-green report with no
 * mention that the React adapter has nothing to attach to.
 */
export const UiLibrary = {
  REACT: 'react',
  PREACT: 'preact',
  VUE: 'vue',
  SVELTE: 'svelte',
  UNKNOWN: 'unknown',
} as const;
export type UiLibrary = (typeof UiLibrary)[keyof typeof UiLibrary];

export interface Detection {
  framework: Framework;
  uiLibrary: UiLibrary;
  /**
   * Whether the project is TypeScript. Not cosmetic: generating a `.tsx` file into a JavaScript
   * project makes Next auto-install TypeScript on the next `next dev`, which on Next 13 takes its
   * require-hook down with it and the dev server never starts.
   */
  typescript: boolean;
  reactMajor: number | undefined;
  /**
   * `react-scripts`' major, when the project has it. `undefined` on every other stack.
   *
   * Load-bearing below 5: react-scripts 4 runs webpack 4, whose parser predates optional chaining
   * and logical assignment. `@reticlehq/browser` ships both untranspiled, and react-scripts excludes
   * `node_modules` from Babel, so the build dies inside our `dist/` before a session can exist
   * (#680). The failure has no diagnostic of its own -- the app simply does not compile.
   *
   * Optional so every existing fixture keeps compiling without naming it; `detect` always sets it.
   */
  reactScriptsMajor?: number | undefined;
  /** React 19 dropped _debugSource, so it needs the build-time source-map stamp. */
  needsSourceMapping: boolean;
  /**
   * Whether this project renders through a NON-DOM React reconciler, in which case the
   * `data-reticle-source` stamp must be switched off for the whole app.
   *
   * React is a reconciler interface, not a renderer. A lowercase JSX tag is a host element in
   * every renderer, but only in React DOM is a host element a node that takes attributes. The
   * babel plugin's allowlist keeps the stamp off `<mesh>` and `<group>`, and it cannot help with
   * the tags that COLLIDE: `<line>` is both SVG's and `THREE.Line`, `<audio>` is both. R3F's
   * `applyProps` reads any dashed prop as a pierced property path, walks `data` -> `reticle` on a
   * three.js instance that has no `data`, and throws from inside the commit phase — which unmounts
   * the entire tree to a white screen, long after the app looked fine.
   *
   * A tag name alone cannot separate the two, and a lexical "is it under a <Canvas>" walk only sees
   * the file being transformed. The manifest can: an app that depends on one of these renderers has
   * the collision, so `init` writes `sourceMapping: false` rather than shipping a crash. The cost is
   * source pointers on that app; the alternative cost is the app.
   *
   * Optional so every existing fixture keeps compiling without naming it, in the one direction a
   * default here can be wrong safely: absent means an ordinary React DOM app, which is what an
   * unstated fixture is. `detect` always sets it.
   */
  customReconciler?: boolean | undefined;
  /**
   * Whether this project depends on react-three-fiber (or the legacy package name). A WebGL /
   * R3F subtree is a blank `<canvas>` to Reticle: DOM, state and network around it still work;
   * picking and observing inside the scene do not. Optional for the same reason as
   * `customReconciler` — absent means an ordinary DOM app.
   */
  webGlSubtree?: boolean | undefined;
  packageManager: PackageManager;
  /**
   * The prefix this run can actually invoke `packageManager` through — see `preflight.ts` (#1149) for
   * why that can be `corepack <packageManager>` rather than the bare name. Undefined here: `detect` is
   * pure and never probes a binary, so this is filled in by `run.ts` from `preflight`'s result, before
   * the plan is built. Every later spawn or printed command for the package manager reads this rather
   * than `packageManager` alone.
   */
  packageManagerCommand?: string;
  /**
   * Every dependency this package DECLARES, by name, merged across the three blocks.
   *
   * So the planner can tell "not wired yet" from "wired already". Without it the install step could
   * only ever say APPLY, and a re-run over an instrumented project therefore ran a package-manager
   * install it did not need - which is the step that touches `node_modules`.
   *
   * Optional so every existing construction keeps working; absent reads as "nothing known", which
   * installs, and installing twice is the harmless direction.
   */
  dependencies?: Readonly<Record<string, string>> | undefined;
}

const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];
const VITE_CONFIGS = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts'];
const ELECTRON_VITE_CONFIGS = [
  'electron.vite.config.ts',
  'electron.vite.config.js',
  'electron.vite.config.mjs',
  'electron.vite.config.mts',
];
const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs'];
const REACT_ROUTER_CONFIGS = [
  'react-router.config.ts',
  'react-router.config.js',
  'react-router.config.mjs',
];
const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];
/** The classic Remix compiler's config. Remix on Vite has none; its dependency is the signal. */
const REMIX_CONFIGS = ['remix.config.js', 'remix.config.mjs', 'remix.config.cjs'];
/** Forge's renderer build — the only one of its three Vite configs with a document. */
export const FORGE_RENDERER_CONFIGS = [
  'vite.renderer.config.ts',
  'vite.renderer.config.mts',
  'vite.renderer.config.js',
  'vite.renderer.config.mjs',
];
/** The Angular CLI workspace file. */
export const ANGULAR_WORKSPACE_FILE = 'angular.json';
const ASTRO_CONFIGS = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.cjs',
];

function depVersion(pkg: PackageJsonLike, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
}

/**
 * React renderers whose host instances are not DOM nodes. Presence of any one of them means a
 * lowercase JSX tag in this project may not be an element. See `Detection.customReconciler`.
 */
const CUSTOM_RECONCILER_DEPS = [
  '@react-three/fiber',
  'react-three-fiber',
  '@react-pdf/renderer',
  'ink',
  'react-native',
];

/** Packages whose presence means the product's main surface is a WebGL canvas, not the DOM. */
const WEBGL_SUBTREE_DEPS = ['@react-three/fiber', 'react-three-fiber'] as const;

function hasAnyConfig(files: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((c) => files.has(c));
}

/** What identifies one framework in a project root: a dependency name, or a config file basename. */
interface FrameworkSignals {
  /** `package.json` dependency names that name this framework outright. */
  readonly deps: readonly string[];
  /**
   * Dependencies that disprove this framework's dependency signal, without affecting an explicit
   * config-file signal.
   *
   * Vinext carries `next` for API compatibility but builds through Vite, so treating `next` as
   * conclusive there would install wiring that Vinext never evaluates.
   */
  readonly depsUnless?: readonly string[];
  /** Root config-file basenames that name it when the dependency is absent. */
  readonly configs: readonly string[];
  /**
   * Root files whose PRESENCE disproves the config-file signal (the dependency signal is
   * conclusive either way).
   *
   * SvelteKit is the only user: a plain Svelte + Vite SPA ships `svelte.config.js` too, for
   * `@sveltejs/vite-plugin-svelte`'s preprocessor options and with no `kit` block. Reading the
   * config file alone misclassified a real project, and `init` wrote a SvelteKit-only
   * `src/hooks.client.ts` bootstrap that nothing on that project could ever import. SvelteKit
   * renders through `src/app.html` and never ships a root `index.html`, where a plain Vite SPA
   * always has one.
   */
  readonly configsUnless?: readonly string[];
}

/** The root document a plain Vite SPA serves — and a framework that SSRs its own HTML never has. */
const VITE_INDEX_HTML = 'index.html';

/**
 * The detection half of the per-framework table.
 *
 * It is a `Record<Framework, …>` for the reason `frameworkPackages` and `FRAMEWORK_ADAPTERS` are:
 * a member added to `Framework` with no signals here is a compile error rather than a framework
 * that is quietly never detected. The globs used to be seven loose `const` arrays read by an
 * if/else chain, so a new framework with no branch was classified as whatever matched next and
 * wired for THAT — the SvelteKit and React Router failure, one step upstream of the plan.
 *
 * Deliberately NOT merged into `FRAMEWORK_ADAPTERS`: that record holds the plan's step builders,
 * which import this module transitively, so folding detection into it would make "what is this
 * project" depend on "how do we wire it". Both halves are completed by the compiler; the seam is
 * asserted in `framework-adapter.test.ts`.
 */
export const FRAMEWORK_SIGNALS: Record<Framework, FrameworkSignals> = {
  [Framework.NEXT]: { deps: ['next'], depsUnless: ['vinext'], configs: NEXT_CONFIGS },
  [Framework.NUXT]: { deps: ['nuxt'], configs: NUXT_CONFIGS },
  [Framework.SVELTEKIT]: {
    deps: ['@sveltejs/kit'],
    configs: SVELTE_CONFIGS,
    configsUnless: [VITE_INDEX_HTML],
  },
  [Framework.ASTRO]: { deps: ['astro'], configs: ASTRO_CONFIGS },
  /**
   * `@react-router/dev` or a `react-router.config.*`, never `react-router` itself — library mode is
   * a plain Vite app whose index.html the plugin does reach.
   */
  [Framework.REACT_ROUTER]: { deps: ['@react-router/dev'], configs: REACT_ROUTER_CONFIGS },
  /**
   * electron-vite's config holds three build configs (main/preload/renderer) and only the renderer
   * has a DOM, so it must never fall through to the generic Vite path.
   */
  [Framework.ELECTRON_VITE]: { deps: ['electron-vite'], configs: ELECTRON_VITE_CONFIGS },
  /**
   * The Vite plugin, not `@electron-forge/cli`: a Forge app on the webpack template has no Vite
   * config to patch, and claiming it here would hand it steps that cannot apply.
   */
  [Framework.ELECTRON_FORGE]: {
    deps: ['@electron-forge/plugin-vite'],
    configs: FORGE_RENDERER_CONFIGS,
  },
  /** `@remix-run/dev` is both compilers' package; the plan tells them apart by the Vite config. */
  [Framework.REMIX]: { deps: ['@remix-run/dev'], configs: REMIX_CONFIGS },
  [Framework.ANGULAR]: { deps: ['@angular/core'], configs: [ANGULAR_WORKSPACE_FILE] },
  /**
   * The Start packages, never Query or Router alone — those stay on the Vite path. Start has no
   * config file of its own to key on.
   */
  [Framework.TANSTACK_START]: {
    deps: ['@tanstack/react-start', '@tanstack/start'],
    configs: [],
  },
  [Framework.VITE]: { deps: ['vite', 'vinext'], configs: VITE_CONFIGS },
  /** CRA has no config file at all, so the dependency is the only signal. */
  [Framework.CRA]: { deps: ['react-scripts'], configs: [] },
  /** Nothing identifies plain HTML; it is where the chain below ends. */
  [Framework.HTML]: { deps: [], configs: [] },
};

/**
 * The precedence chain, and every line of it is load-bearing.
 *
 * Nuxt, SvelteKit, Astro and React Router all come BEFORE Vite: each is Vite-based, so the generic
 * Vite branch would match them, and each renders its own HTML — so the plugin's `transformIndexHtml`
 * injection never fires and `init` would report every step green over an app that never connects.
 * CRA comes AFTER Vite, because a project migrating off CRA carries both and the Vite path is the
 * one that works. `Framework.HTML` is the fall-through and so is absent here.
 */
export const DETECTION_ORDER: readonly Framework[] = [
  Framework.NEXT,
  Framework.NUXT,
  Framework.SVELTEKIT,
  Framework.ASTRO,
  Framework.ELECTRON_VITE,
  // Before Vite, for the reason electron-vite is: Forge's template depends on `vite` directly.
  Framework.ELECTRON_FORGE,
  Framework.REACT_ROUTER,
  // After React Router, so an app half-way through the Remix -> React Router upgrade gets the
  // successor's wiring; before Vite, because Remix on Vite depends on `vite` directly.
  Framework.REMIX,
  Framework.TANSTACK_START,
  Framework.VITE,
  // After Vite: an Analog app is Angular on Vite, and the Vite plugin's index.html injection reaches
  // it. A CLI app never depends on `vite` itself — the CLI bundles its own.
  Framework.ANGULAR,
  Framework.CRA,
];

/** Extract the leading major version from a semver range like "^19.0.0" or "19.1.1". */
export function parseMajor(range: string | undefined): number | undefined {
  if (range === undefined) return undefined;
  const match = range.match(/(\d+)/);
  if (null === match || match[1] === undefined) return undefined;
  const major = parseInt(match[1], 10);
  return isNaN(major) ? undefined : major;
}

/**
 * Markers each package manager leaves INSIDE `node_modules`. An installed tree is the strongest
 * evidence there is — stronger than a lockfile, which may simply not be committed.
 *
 * Without this, a pnpm-installed project with no committed lockfile was read as npm, and `npm i -D`
 * then died on pnpm's symlink layout with `Cannot read properties of null (reading 'matches')`. Worse,
 * it left the package present in `node_modules` but absent from `package.json`, so every later run
 * reported the same failure — a setup that could not be retried into working.
 */
const NODE_MODULES_MARKERS: readonly (readonly [string, PackageManager])[] = [
  ['.modules.yaml', PackageManager.PNPM],
  ['.yarn-state.yml', PackageManager.YARN],
  ['.package-lock.json', PackageManager.NPM],
];

/** Marker basenames present inside the project's `node_modules`, if it has one. */
function packageManagerFromNodeModules(markers: ReadonlySet<string>): PackageManager | undefined {
  for (const [name, pm] of NODE_MODULES_MARKERS) if (markers.has(name)) return pm;
  return undefined;
}

/**
 * Whether an installed tree identifies the manager that built it. Callers use this to decide whether
 * they still need weaker evidence — see `resolveLockfiles`, which stops inheriting an ancestor
 * lockfile once the project's own tree can answer the question.
 */
export function namesAPackageManager(markers: ReadonlySet<string>): boolean {
  return packageManagerFromNodeModules(markers) !== undefined;
}

/**
 * The manager a project DECLARES, via corepack's `packageManager` field.
 *
 * The strongest signal there is, and stronger than anything else here: a lockfile is evidence of
 * what was run once, an installed tree is evidence of what was run last, and this is the project
 * SAYING which one it uses. Corepack enforces it — it refuses to run a different manager on the
 * project's behalf — so choosing against it produces a command that cannot work.
 *
 * Unrecognised values fall through rather than defaulting. A field naming something we do not know
 * must not quietly become npm; that is how a pnpm repo gets an `npm i`.
 */
function packageManagerFromField(pkg: unknown): PackageManager | undefined {
  if ('object' !== typeof pkg || null === pkg) return undefined;
  const declared = (pkg as Record<string, unknown>)['packageManager'];
  if ('string' !== typeof declared) return undefined;
  // `name@version`, and the version is not ours to care about — only which binary runs.
  const name = declared.split('@')[0]?.trim().toLowerCase();
  const known: Record<string, PackageManager> = {
    npm: PackageManager.NPM,
    pnpm: PackageManager.PNPM,
    yarn: PackageManager.YARN,
    bun: PackageManager.BUN,
  };
  return name === undefined ? undefined : known[name];
}

export function detectPackageManager(
  lockfiles: ReadonlySet<string>,
  nodeModulesMarkers: ReadonlySet<string>,
  pkg?: unknown,
): PackageManager {
  // What the project SAYS beats every trace of what was once run in it. Reported from the field: an
  // already-instrumented npm workspaces project had a pnpm dependency migration run over it, which
  // moved its `node_modules` aside and broke the dev server. Moving an installed tree is not
  // something a scaffolder may do to a working checkout.
  const declared = packageManagerFromField(pkg);
  if (declared !== undefined) return declared;
  if (lockfiles.has('pnpm-lock.yaml')) return PackageManager.PNPM;
  if (lockfiles.has('yarn.lock')) return PackageManager.YARN;
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return PackageManager.BUN;
  // No lockfile is not the same as "npm". An already-installed tree says which manager built it.
  return packageManagerFromNodeModules(nodeModulesMarkers) ?? PackageManager.NPM;
}

/** Every declared dependency, by name. Later blocks do not override earlier ones by accident. */
function declaredDependencies(pkg: PackageJsonLike): Readonly<Record<string, string>> {
  return { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
}

function detectFramework(input: DetectInput): Framework {
  for (const framework of DETECTION_ORDER) {
    const signals = FRAMEWORK_SIGNALS[framework];
    const hasDisqualifyingDependency =
      true === signals.depsUnless?.some((d) => depVersion(input.pkg, d) !== undefined);
    if (
      signals.deps.some((d) => depVersion(input.pkg, d) !== undefined) &&
      !hasDisqualifyingDependency
    ) {
      return framework;
    }
    if (
      hasAnyConfig(input.configFiles, signals.configs) &&
      !hasAnyConfig(input.configFiles, signals.configsUnless ?? [])
    ) {
      return framework;
    }
  }
  return Framework.HTML;
}

/**
 * React first: a Preact app using preact/compat aliases React, and Next/Remix apps list both. The
 * order is the precedence — whichever the app actually renders through is the one it depends on
 * directly.
 */
function detectUiLibrary(pkg: PackageJsonLike): UiLibrary {
  if (depVersion(pkg, 'react') !== undefined) return UiLibrary.REACT;
  if (depVersion(pkg, 'preact') !== undefined) return UiLibrary.PREACT;
  if (depVersion(pkg, 'vue') !== undefined) return UiLibrary.VUE;
  if (depVersion(pkg, 'svelte') !== undefined) return UiLibrary.SVELTE;
  return UiLibrary.UNKNOWN;
}

const TS_CONFIGS = ['tsconfig.json'];

export function detect(input: DetectInput): Detection {
  const reactMajor = parseMajor(depVersion(input.pkg, 'react'));
  return {
    framework: detectFramework(input),
    reactScriptsMajor: parseMajor(depVersion(input.pkg, 'react-scripts')),
    uiLibrary: detectUiLibrary(input.pkg),
    typescript:
      hasAnyConfig(input.configFiles, TS_CONFIGS) ||
      depVersion(input.pkg, 'typescript') !== undefined,
    reactMajor,
    needsSourceMapping: reactMajor !== undefined && reactMajor >= 19,
    customReconciler: CUSTOM_RECONCILER_DEPS.some(
      (name) => depVersion(input.pkg, name) !== undefined,
    ),
    webGlSubtree: WEBGL_SUBTREE_DEPS.some((name) => depVersion(input.pkg, name) !== undefined),
    packageManager: detectPackageManager(
      input.lockfiles,
      input.nodeModulesMarkers ?? new Set(),
      input.pkg,
    ),
    dependencies: declaredDependencies(input.pkg),
  };
}

const INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  [PackageManager.PNPM]: ['add', '-D'],
  [PackageManager.YARN]: ['add', '-D'],
  [PackageManager.BUN]: ['add', '-d'],
  [PackageManager.NPM]: ['i', '-D'],
};

/**
 * Flags added only to the install we RUN, never to the one we print.
 *
 * The install is a child process whose output lands above ours. Measured on a real install: the run
 * opened with "added 602 packages", a funding notice, and "14 vulnerabilities (7 moderate, 7 high)"
 * with `npm audit fix` advice, before one line of Reticle output. A user's first impression of a
 * verification tool was a wall of somebody else's security warnings, at exactly the moment they are
 * deciding whether this tool is careful — and that audit summary describes their existing dependency
 * tree, which our two dev packages neither caused nor can fix.
 *
 * Kept off `installCommand`, which is the string shown in the plan and the one a user copies when
 * running it by hand: nobody should be taught to type our noise-suppression flags.
 *
 * Quieted, never silenced — the exit code and stderr are untouched, so a real failure of the step
 * everything downstream depends on stays as loud as it was.
 *
 * npm only: pnpm, yarn and bun reject these, and an unknown flag would turn a working install into a
 * hard failure, which is the opposite of the problem being fixed.
 */
const QUIET_INSTALL_ARGS: Partial<Record<PackageManager, readonly string[]>> = {
  // `--no-update-notifier` joined the other two for the same reason and from the same measurement:
  // a re-capture of a pristine Vite first run spent five of its lines on an `npm notice` block
  // announcing a newer npm, its changelog url and the command to install it. Advice about npm,
  // printed in the middle of somebody wiring up a different tool.
  [PackageManager.NPM]: ['--no-audit', '--no-fund', '--no-update-notifier'],
};

interface InstallCommand {
  command: string;
  args: string[];
}

/** Build a dev-dependency install command for one or more packages (e.g. the kit + its build plugin). */
export function installCommandParts(
  pm: PackageManager,
  pkgs: string | readonly string[],
  /**
   * Extra flags for a RETRY, never for the first attempt.
   *
   * Appended after the quiet flags so a caller cannot accidentally displace them, and typed
   * separately from `pkgs` so a flag can never be mistaken for a package name — which is exactly
   * how `npm i -D --legacy-peer-deps` would become a request to install a package called
   * `--legacy-peer-deps` on a manager that does not recognise the flag.
   */
  extraFlags: readonly string[] = [],
  /**
   * The prefix that actually invokes `pm` on this machine — `pm` itself, or `corepack ${pm}` on a
   * corepack-only machine (see `Detection.packageManagerCommand`). Defaults to `pm` so every existing
   * caller keeps spawning the bare binary without naming this.
   */
  prefix: string = pm,
): InstallCommand {
  const list = 'string' === typeof pkgs ? [pkgs] : pkgs;
  // A bare `pm` is one word and stays the whole command; `corepack ${pm}` splits so `corepack` is the
  // program `spawnAllowed` runs and `pm` is its first argument — the shape `RUNNABLE_COMMANDS` and the
  // corepack probe both expect.
  const [command, ...leadingArgs] = prefix.split(' ');
  return {
    command: command ?? pm,
    args: [
      ...leadingArgs,
      ...INSTALL_ARGS[pm],
      ...list,
      ...(QUIET_INSTALL_ARGS[pm] ?? []),
      ...extraFlags,
    ],
  };
}

/**
 * The install command as a human reads it — and deliberately NOT `installCommandParts` joined.
 *
 * This string is what the plan prints and what a user retypes when running the step by hand, so it
 * must not carry the flags we add only to quieten our own child process. Built from `INSTALL_ARGS`
 * directly for that reason; routing it through the parts would put `--no-audit --no-fund` in front of
 * every reader and teach them our noise-suppression as if it were part of installing Reticle.
 */
export function installCommand(
  pm: PackageManager,
  pkgs: string | readonly string[],
  /** As in `installCommandParts` — what a corepack-only machine has to type instead of bare `pm`. */
  prefix: string = pm,
): string {
  const list = 'string' === typeof pkgs ? [pkgs] : pkgs;
  return `${prefix} ${[...INSTALL_ARGS[pm], ...list].join(' ')}`;
}

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
export interface FrameworkSignals {
  /** `package.json` dependency names that name this framework outright. */
  readonly deps: readonly string[];
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
  [Framework.NEXT]: { deps: ['next'], configs: NEXT_CONFIGS },
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
   * The Start packages, never Query or Router alone — those stay on the Vite path. Start has no
   * config file of its own to key on.
   */
  [Framework.TANSTACK_START]: {
    deps: ['@tanstack/react-start', '@tanstack/start'],
    configs: [],
  },
  [Framework.VITE]: { deps: ['vite'], configs: VITE_CONFIGS },
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
  Framework.REACT_ROUTER,
  Framework.TANSTACK_START,
  Framework.VITE,
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

export function detectPackageManager(
  lockfiles: ReadonlySet<string>,
  nodeModulesMarkers: ReadonlySet<string>,
): PackageManager {
  if (lockfiles.has('pnpm-lock.yaml')) return PackageManager.PNPM;
  if (lockfiles.has('yarn.lock')) return PackageManager.YARN;
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return PackageManager.BUN;
  // No lockfile is not the same as "npm". An already-installed tree says which manager built it.
  return packageManagerFromNodeModules(nodeModulesMarkers) ?? PackageManager.NPM;
}

function detectFramework(input: DetectInput): Framework {
  for (const framework of DETECTION_ORDER) {
    const signals = FRAMEWORK_SIGNALS[framework];
    if (signals.deps.some((d) => depVersion(input.pkg, d) !== undefined)) return framework;
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
    packageManager: detectPackageManager(input.lockfiles, input.nodeModulesMarkers ?? new Set()),
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
  [PackageManager.NPM]: ['--no-audit', '--no-fund'],
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
): InstallCommand {
  const list = 'string' === typeof pkgs ? [pkgs] : pkgs;
  return {
    command: pm,
    args: [...INSTALL_ARGS[pm], ...list, ...(QUIET_INSTALL_ARGS[pm] ?? []), ...extraFlags],
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
export function installCommand(pm: PackageManager, pkgs: string | readonly string[]): string {
  const list = 'string' === typeof pkgs ? [pkgs] : pkgs;
  return `${pm} ${[...INSTALL_ARGS[pm], ...list].join(' ')}`;
}

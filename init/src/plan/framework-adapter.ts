/**
 * One record per framework, in one table the compiler refuses to leave a hole in.
 *
 * Adding a framework used to mean editing nine places — the enum, the detection globs, the
 * detection chain, the package switch, an ad-hoc `SVELTEKIT || NUXT` pair test, the step switch,
 * the step builder, the connect snippet, the connect-step title set — and only two of them went
 * red when missed. The rest failed the way this whole area fails: `init` printed a clean plan and
 * the app never dialled the daemon.
 *
 * Everything that is per-framework AND mechanical lives here. What is NOT here is deliberate:
 *
 * - Detection (`FRAMEWORK_SIGNALS` / `DETECTION_ORDER` in `detect.ts`). The step builders below
 *   import `detect.ts` transitively, so folding detection in would make the module that answers
 *   "what is this project" depend on the module that answers "how do we wire it". It is a
 *   `Record<Framework, …>` of its own there, so it is completed by the compiler just the same.
 * - The snippet builders (`snippets.ts`). Each is a different recipe in a different language, and
 *   they are reached through the `steps` builder anyway.
 *
 * `framework-adapter.test.ts` asserts the seam between the two halves.
 */

import { Framework, UiLibrary } from '@/detect/detect.js';
import { StepTitle } from './connect-steps.js';
import {
  astroSteps,
  craSteps,
  htmlSteps,
  nextSteps,
  nuxtSteps,
  reactRouterSteps,
  svelteKitSteps,
  tanstackStartSteps,
} from './plan-framework.js';
import { VITE_PLUGIN_DETAIL, viteSteps } from './plan-vite.js';
import { electronForgeSteps, electronViteSteps } from './plan-electron-vite.js';
import { angularSteps } from './plan-angular.js';
import { REMIX_CLASSIC_MANUAL, remixEntryFile } from '@/patch/remix.js';
import { StepStatus } from './plan-types.js';
import type { PlanInput, Step } from './plan-types.js';

/** Where the classic Remix compiler's ⚠ points: the file that says which compiler this is. */
const REMIX_CLASSIC_TARGET = 'remix.config.js';

/**
 * Remix v2: React Router framework mode's steps, with Remix's own default entry and title.
 *
 * No Vite config is the classic compiler — `vitePlugin` is the only way Remix runs on Vite, and it
 * lives in that file — and wiring the entry there would import a module nothing serves.
 */
function remixSteps(input: PlanInput): Step[] {
  if (null === input.viteConfig) {
    return [
      {
        title: StepTitle.CONNECT_SNIPPET_REMIX,
        target: REMIX_CLASSIC_TARGET,
        status: StepStatus.MANUAL,
        detail: REMIX_CLASSIC_MANUAL,
      },
    ];
  }
  return [
    ...reactRouterSteps(input, StepTitle.CONNECT_SNIPPET_REMIX, remixEntryFile),
    // The plugin stamps file:line, and it is also what serves the `/@reticle-connect` module the
    // entry imports.
    ...viteSteps(input, VITE_PLUGIN_DETAIL.REACT_ROUTER),
  ];
}

// An app dev installs exactly the audience-scoped browser-side dependencies — never the retired
// `@reticlehq/core` umbrella (which dragged the Node MCP server + ws into every app). The kit is the
// framework adapter (it re-exports the browser sensor), paired with that framework's dev-only build
// plugin for source mapping + connect injection.
export const RETICLE_REACT_KIT = '@reticlehq/react';
/** The framework-neutral sensor, for stacks the React adapter has nothing to attach to. */
export const RETICLE_BROWSER_SDK = '@reticlehq/browser';
const RETICLE_VITE_PLUGIN = '@reticlehq/vite-plugin';
const RETICLE_NEXT_PLUGIN = '@reticlehq/next';
/** The Electron main/preload helper — what makes IPC and screenshots exist at all. */
const RETICLE_ELECTRON = '@reticlehq/electron';

interface FrameworkAdapter {
  /**
   * The dev dependencies `init` installs, given the kit the UI-library check chose
   * (`@reticlehq/react` or the neutral sensor). A framework that knows its own renderer ignores the
   * argument — Next is React by construction and Nuxt is Vue, so neither has a detection result
   * worth honouring here.
   */
  readonly packages: (kit: string) => readonly string[];
  /** The per-framework half of the plan. */
  readonly steps: (input: PlanInput) => Step[];
  /**
   * The steps WITHOUT which this framework's app never dials the daemon.
   *
   * `connect-steps.ts` decides whether a ⚠ makes `init` exit non-zero, and it does so from a
   * hand-written set of titles. A framework whose connect step is missing from that set reports the
   * ⚠ and exits 0 over an app that cannot connect; the test pins that no entry here is unknown to
   * it, and that between them the entries account for the whole set.
   */
  readonly connectStepTitles: readonly StepTitle[];
  /**
   * Whether this framework's own recipe already says it is unverified.
   *
   * Read by the generic "<library> is UNVERIFIED" notice, which must not argue with the more
   * specific wording a recipe carries. This replaced a literal `SVELTEKIT || NUXT` test — a pair
   * that had to be remembered, and is not the same question as "renders its own HTML" (Astro and
   * React Router do that too and DO want the generic notice).
   */
  readonly carriesOwnUnverifiedNote: boolean;
}

/**
 * The stacks the install gate scaffolds from scratch on every change (`SCAFFOLDS` in
 * `apps/e2e/install-gate.mjs`), as framework → the UI libraries its scaffolds render.
 *
 * The one place `init` says which setups are PROVEN. Nuxt was labelled "vue is UNVERIFIED" while the
 * gate scaffolded it on every change, because nothing here knew the gate existed. Add a scaffold
 * there, add its stack here. Only the setup is proven: no gate drives these apps to a verdict.
 */
const INSTALL_GATE_STACKS: Partial<Record<Framework, readonly UiLibrary[]>> = {
  [Framework.VITE]: [UiLibrary.REACT, UiLibrary.VUE, UiLibrary.UNKNOWN],
  [Framework.NEXT]: [UiLibrary.REACT],
  [Framework.NUXT]: [UiLibrary.VUE],
  [Framework.REACT_ROUTER]: [UiLibrary.REACT],
  [Framework.REMIX]: [UiLibrary.REACT],
  [Framework.ASTRO]: [UiLibrary.UNKNOWN],
  [Framework.SVELTEKIT]: [UiLibrary.SVELTE],
  [Framework.CRA]: [UiLibrary.REACT],
  [Framework.ANGULAR]: [UiLibrary.UNKNOWN],
};

/** Whether the install gate scaffolds this stack — see INSTALL_GATE_STACKS. */
export function installGated(framework: Framework, uiLibrary: UiLibrary): boolean {
  return INSTALL_GATE_STACKS[framework]?.includes(uiLibrary) ?? false;
}

export const FRAMEWORK_ADAPTERS: Record<Framework, FrameworkAdapter> = {
  [Framework.NEXT]: {
    // Next is React by construction, so the detection cannot disagree in a way worth honouring.
    packages: () => [RETICLE_REACT_KIT, RETICLE_NEXT_PLUGIN],
    steps: nextSteps,
    connectStepTitles: [StepTitle.RETICLE_DEV_COMPONENT, StepTitle.MOUNT_RETICLE_DEV],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.NUXT]: {
    // The framework-neutral sensor, NOT the React kit. Nuxt renders Vue, and installing a package
    // named @reticlehq/react — with `react` in its peer dependencies — into a Vue codebase is the
    // single thing most likely to make someone abandon the setup, whether or not it works.
    packages: () => [RETICLE_BROWSER_SDK],
    steps: nuxtSteps,
    // BOTH halves. The config is the only thing in a Nuxt app that can inline the pairing token,
    // and the bridge refuses a connect without one even on localhost — so a ⚠ on it is a guaranteed
    // non-connection, not a caveat.
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_NUXT, StepTitle.NUXT_CONFIG],
    // FALSE since `init` started writing the plugin itself. The Nuxt recipe carries an UNVERIFIED
    // line and is now only the fallback for a config we could not patch — so on the path everybody
    // takes, suppressing the generic note left a Vue app with no honesty line at all. The generic
    // one is also the more accurate of the two now: the install gate scaffolds Nuxt from scratch on
    // every change, so the SETUP is proven and only the drive is not, which is what it says.
    carriesOwnUnverifiedNote: false,
  },
  [Framework.VITE]: {
    // The build plugin stamps `data-reticle-source` regardless of UI library, so a Vue or Svelte
    // app still gets source pointers — it is only component identity that needs the React kit.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    steps: (input) => viteSteps(input),
    connectStepTitles: [StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.REACT_ROUTER]: {
    // React Router framework mode is a Vite app that renders React, so the kit and the plugin are
    // both right for it too — only the connect INJECTION differs, and that is the plan's business.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    // The Vite plugin too, for the reason SvelteKit gets it: React Router framework mode IS a Vite
    // app, and the plugin is what stamps data-reticle-source. Without it the app connects and every
    // verdict comes back with no file:line. Injection stays ON, unlike SvelteKit and Start: the
    // client entry imports `/@reticle-connect`, which the plugin serves only while inject is on, and
    // that module is what loads the dev module here.
    steps: (input) => [
      ...reactRouterSteps(input),
      ...viteSteps(input, VITE_PLUGIN_DETAIL.REACT_ROUTER),
    ],
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_REACT_ROUTER, StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.SVELTEKIT]: {
    // SvelteKit builds on Vite; until a dedicated Svelte kit exists it uses the Vite build plugin.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    // The Vite plugin as well as the client hook. `init` already INSTALLS @reticlehq/vite-plugin for
    // SvelteKit and then never wired it into the config, so it sat in package.json doing nothing —
    // which is why a SvelteKit app connected fine and every verdict had no file:line.
    // `inject: false` because the client hook connects; the plugin's injection never fires here, and
    // left on it only warns ten seconds into every page load that the app will never connect.
    steps: (input) => [
      ...svelteKitSteps(input),
      ...viteSteps(input, VITE_PLUGIN_DETAIL.SVELTEKIT, false),
    ],
    connectStepTitles: [StepTitle.CLIENT_HOOK, StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: true,
  },
  [Framework.ASTRO]: {
    // Astro owns its own Vite instance and renders its own HTML, so there is no config for the
    // plugin to attach to — the kit alone, connected from a local module the page imports
    // (see astroManual).
    packages: (kit) => [kit],
    steps: astroSteps,
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_ASTRO, StepTitle.ASTRO_RETICLE_DEV],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.ELECTRON_VITE]: {
    // Same kit + Vite plugin as a plain Vite app, plus the Electron main/preload helper. The plugin
    // still stamps and injects; `@reticlehq/electron` is what makes IPC and screenshots exist.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN, RETICLE_ELECTRON],
    steps: electronViteSteps,
    // electron-vite's connect IS the renderer plugin. The preload and capture steps add IPC and
    // screenshots to a session; without the plugin there is no session to add them to.
    connectStepTitles: [StepTitle.ELECTRON_VITE_PLUGIN],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.ELECTRON_FORGE]: {
    // electron-vite's three packages, with the kit the UI-library check chose: Forge's Vite template
    // renders no React, and `@reticlehq/react` carries `react` in its peer dependencies.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN, RETICLE_ELECTRON],
    steps: electronForgeSteps,
    // The renderer config's plugin IS the connect, as under electron-vite.
    connectStepTitles: [StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.REMIX]: {
    // React Router framework mode's packages, for the reason its steps are that mode's: the same
    // framework under its previous name.
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    steps: remixSteps,
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_REMIX, StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.ANGULAR]: {
    // The sensor alone. There is no build plugin for the Angular CLI to load, and the React kit is
    // what used to be installed here, with `react` beside it.
    packages: () => [RETICLE_BROWSER_SDK],
    steps: angularSteps,
    connectStepTitles: [
      StepTitle.CONNECT_SNIPPET_ANGULAR,
      StepTitle.ANGULAR_TOKEN_PROXY,
      StepTitle.ANGULAR_SERVE_CONFIG,
    ],
    carriesOwnUnverifiedNote: true,
  },
  [Framework.TANSTACK_START]: {
    // Start IS a Vite app, so the plugin still stamps `data-reticle-source` — only the connect
    // injection is inapplicable, and that is the plan's business (`inject: false`).
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    steps: (input) => [
      ...tanstackStartSteps(input),
      ...viteSteps(input, VITE_PLUGIN_DETAIL.TANSTACK_START, false),
    ],
    connectStepTitles: [
      StepTitle.CONNECT_SNIPPET_TANSTACK_START,
      StepTitle.TANSTACK_START_CONNECT_COMPONENT,
      StepTitle.VITE_PLUGIN,
    ],
    // The Start recipe carries its own UNVERIFIED line; a second generic notice would argue with it.
    carriesOwnUnverifiedNote: true,
  },
  [Framework.CRA]: {
    // react-scripts owns its webpack config and cannot be extended without ejecting, so there is no
    // build plugin — the kit alone, imported from src/index.tsx (see cra.ts).
    packages: () => [RETICLE_REACT_KIT],
    steps: craSteps,
    connectStepTitles: [StepTitle.CONNECT_MODULE, StepTitle.CONNECT_SNIPPET_CRA],
    carriesOwnUnverifiedNote: false,
  },
  [Framework.HTML]: {
    // No bundler plugin to install — write the static connect into index.html when it is present.
    packages: (kit) => [kit],
    steps: htmlSteps,
    connectStepTitles: [StepTitle.CONNECT_SNIPPET],
    carriesOwnUnverifiedNote: false,
  },
};

/**
 * The per-framework half of the plan, looked up rather than switched.
 *
 * `FRAMEWORK_ADAPTERS` is a `Record<Framework, FrameworkAdapter>`, so a member added to `Framework`
 * is a compile error in that one table instead of a framework the plan quietly does not serve. The
 * exhaustive switch this replaced gave the same guarantee for the steps alone; the record gives it
 * for the packages, the connect-step titles and the unverified-note flag in the same edit.
 */
export function frameworkSteps(input: PlanInput): Step[] {
  return FRAMEWORK_ADAPTERS[input.detection.framework].steps(input);
}

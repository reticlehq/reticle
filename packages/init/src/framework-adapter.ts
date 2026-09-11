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

import { Framework } from './detect.js';
import { StepTitle } from './connect-steps.js';
import {
  VITE_PLUGIN_DETAIL,
  astroSteps,
  craSteps,
  htmlSteps,
  nextSteps,
  nuxtSteps,
  reactRouterSteps,
  svelteKitSteps,
  tanstackStartSteps,
  viteSteps,
} from './plan-framework.js';
import { electronViteSteps } from './plan-electron-vite.js';
import type { PlanInput, Step } from './plan.js';

// An app dev installs exactly the audience-scoped browser-side dependencies — never the retired
// `@reticlehq/core` umbrella (which dragged the Node MCP server + ws into every app). The kit is the
// framework adapter (it re-exports the browser sensor), paired with that framework's dev-only build
// plugin for source mapping + connect injection.
export const RETICLE_REACT_KIT = '@reticlehq/react';
/** The framework-neutral sensor, for stacks the React adapter has nothing to attach to. */
export const RETICLE_BROWSER_SDK = '@reticlehq/browser';
export const RETICLE_VITE_PLUGIN = '@reticlehq/vite-plugin';
export const RETICLE_NEXT_PLUGIN = '@reticlehq/next';
/** The Electron main/preload helper — what makes IPC and screenshots exist at all. */
export const RETICLE_ELECTRON = '@reticlehq/electron';

export interface FrameworkAdapter {
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
    // verdict comes back with no file:line.
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
    steps: (input) => [...svelteKitSteps(input), ...viteSteps(input, VITE_PLUGIN_DETAIL.SVELTEKIT)],
    connectStepTitles: [StepTitle.CLIENT_HOOK, StepTitle.VITE_PLUGIN],
    carriesOwnUnverifiedNote: true,
  },
  [Framework.ASTRO]: {
    // Astro owns its own Vite instance and renders its own HTML, so there is no config for the
    // plugin to attach to — the kit alone, connected from a page <script> (see astroManual).
    packages: (kit) => [kit],
    steps: astroSteps,
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_ASTRO],
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
  [Framework.TANSTACK_START]: {
    // Start IS a Vite app, so the plugin still stamps `data-reticle-source` — only the connect
    // injection is inapplicable, and that is the plan's business (`inject: false`).
    packages: (kit) => [kit, RETICLE_VITE_PLUGIN],
    steps: (input) => [
      ...tanstackStartSteps(input),
      ...viteSteps(input, VITE_PLUGIN_DETAIL.TANSTACK_START, false),
    ],
    connectStepTitles: [StepTitle.CONNECT_SNIPPET_TANSTACK_START, StepTitle.VITE_PLUGIN],
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
    // No bundler plugin to install — just the kit; connect is wired by hand (see htmlManual).
    packages: (kit) => [kit],
    steps: htmlSteps,
    connectStepTitles: [StepTitle.CONNECT_SNIPPET],
    carriesOwnUnverifiedNote: false,
  },
};

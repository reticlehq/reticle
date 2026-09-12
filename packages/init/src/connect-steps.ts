/**
 * The step titles `init` emits, and which of them decide whether the app can dial the daemon.
 *
 * Lifted out of `plan.ts` when that file reached the size backstop. A cohesive unit on its own
 * terms: one question, asked of a step title, with one consequence — a manual step in this set makes
 * `init` exit non-zero instead of reporting a success over an app that can never connect.
 *
 * The membership used to be matched against free strings written out a second time here, so
 * renaming a step in `plan-framework.ts` silently dropped it out of the set and nothing went red.
 * `StepTitle` is now the one place a title is spelled: both files import it, so a rename is a
 * compile error and `plan-framework.test.ts` pins that no builder has drifted back to a literal.
 */

import { CSP_STEP_TITLE } from './csp-check.js';

/** Every fixed title a plan step can carry. The one spelling; nothing writes a title inline. */
export const StepTitle = {
  VITE_PLUGIN: 'Vite plugin',
  CAPABILITIES: 'Capabilities + store',
  CAPABILITIES_TODO: 'AGENT: finish the capabilities file',
  RETICLE_DEV_COMPONENT: 'ReticleDev component',
  NEXT_CONFIG: 'Next config (withReticle)',
  MOUNT_RETICLE_DEV: 'Mount ReticleDev',
  CONNECT_MODULE: 'Reticle connect module',
  PAIRING_TOKEN: 'Pairing token',
  PAIRING_TOKEN_PER_MACHINE: 'Pairing token is per-machine',
  CONNECT_SNIPPET_CRA: 'Connect snippet (CRA)',
  CONNECT_SNIPPET_NUXT: 'Connect snippet (Nuxt)',
  NUXT_CONFIG: 'Nuxt config (token + watcher)',
  NUXT_RESTART: 'Restart the Nuxt dev server',
  CONNECT_SNIPPET_REACT_ROUTER: 'Connect snippet (React Router)',
  CONNECT_SNIPPET_TANSTACK_START: 'Connect snippet (TanStack Start)',
  ELECTRON_VITE_PLUGIN: 'Vite plugin (electron-vite renderer)',
  ELECTRON_PRELOAD: 'Electron preload (IPC shim)',
  ELECTRON_CAPTURE: 'Electron capture (screenshots)',
  TANSTACK_START_UNVERIFIED: 'TanStack Start is UNVERIFIED',
  SVELTEKIT_UNVERIFIED: 'SvelteKit is UNVERIFIED',
  CLIENT_HOOK: 'Reticle client hook',
  CONNECT_SNIPPET_ASTRO: 'Connect snippet (Astro)',
  ASTRO_CONFIG: 'Astro config (token + build target)',
  ASTRO_ENV_DTS: 'Astro env types (Vite defines)',
  CSP: CSP_STEP_TITLE,
  CONNECT_SNIPPET: 'Connect snippet',
} as const;
export type StepTitle = (typeof StepTitle)[keyof typeof StepTitle];

/** Exported for the guard test: every title a step builder emits must be one of these. */
export const STEP_TITLES: readonly StepTitle[] = Object.values(StepTitle);

/**
 * Titles of the steps WITHOUT which no session ever appears.
 *
 * A ⚠ on one of these is not a warning, it is a guaranteed failure: nothing performs the manual step,
 * so the app will not connect and every Reticle tool will answer "no browser session connected".
 * Reported from a field sweep, where the ⚠ count and "did it connect" were treated as independent
 * signals and are not.
 */
export const CONNECT_STEP_TITLES: ReadonlySet<StepTitle> = new Set<StepTitle>([
  StepTitle.CONNECT_SNIPPET,
  StepTitle.CONNECT_SNIPPET_CRA,
  StepTitle.CONNECT_SNIPPET_ASTRO,
  StepTitle.CONNECT_SNIPPET_NUXT,
  // The config is the other half of the Nuxt connect, not a nicety: it is the only thing in a Nuxt
  // app that can inline the pairing token, and the bridge refuses a connect without one even on
  // localhost. A plugin written beside an unpatched config is a guaranteed non-connection.
  StepTitle.NUXT_CONFIG,
  StepTitle.CONNECT_SNIPPET_REACT_ROUTER,
  StepTitle.CONNECT_SNIPPET_TANSTACK_START,
  StepTitle.CLIENT_HOOK,
  StepTitle.CONNECT_MODULE,
  StepTitle.RETICLE_DEV_COMPONENT,
  // Writing the component and MOUNTING it are two steps, and only the write was here. A root layout
  // whose shape `init` does not recognise leaves the component on disk and never rendered: the SDK
  // is in the project, nothing imports it, and `init` exited 0 over an app that could not connect.
  StepTitle.MOUNT_RETICLE_DEV,
  // NOT here, and the reason is worth keeping: `StepTitle.PAIRING_TOKEN`.
  //
  // It is a genuine connect step — CRA inlines only REACT_APP_*, so without the token in the env
  // file the bridge refuses every connection and the app boots, looks correct, and never pairs. But
  // it goes MANUAL in exactly one situation: no daemon has ever run on this machine, so there is no
  // token to inline. That is the FIRST CRA install on a fresh machine, i.e. the first-time user —
  // and making that exit non-zero reports a broken install to the one person least able to tell
  // that it is not.
  //
  // The real fix is for `init` to mint the token rather than only read it, which is what both the
  // daemon and the Vite plugin already do. `runInit` is synchronous and the existing helpers are
  // not, and `gate:install` scaffolds no CRA app, so that change would ship with no coverage of the
  // path it changes. It is worth doing, and worth doing with a scaffold behind it.
  StepTitle.VITE_PLUGIN,
  // electron-vite's connect IS the renderer plugin. Without it the SDK never injects, and the
  // preload/capture steps are not enough to produce a session.
  StepTitle.ELECTRON_VITE_PLUGIN,
]);

/** True when this step is what makes the app dial the daemon. */
export function isConnectStep(title: string): boolean {
  return (CONNECT_STEP_TITLES as ReadonlySet<string>).has(title);
}

/**
 * The Vite half of the plan: the `reticle()` plugin in a Vite config, and the dev module that
 * carries `registerCapabilities` / `registerStore`.
 *
 * Split out of `plan-framework.ts`, which had grown to the edge of the line cap. It is its own
 * module because every Vite-based stack (plain Vite, SvelteKit, React Router, Remix, TanStack
 * Start, the Electron renderers) composes these steps, while the rest of `plan-framework.ts` is one
 * builder per framework that has its own files to write.
 */

import { newViteConfig, patchViteConfig, VitePatchKind, VITE_IMPORT } from '@/patch/vite-config.js';
import { viteManual, viteDevModuleFile, VITE_DEV_MODULE_PATH } from '@/patch/snippets.js';
import { hasOptOut, OPT_OUT_MARKER } from '@/detect/declared/init-opt-out.js';
import { Framework } from '@/detect/detect.js';
import { StepStatus, type PlanInput, type Step } from './plan-types.js';
import { StepTitle } from './connect-steps.js';
import { alreadyOrMovedPort } from './port-steps.js';

/** What adding `reticle()` to a Vite config buys, which differs by framework. */
export const VITE_PLUGIN_DETAIL = {
  /** A plain Vite app gets both halves from the plugin. */
  VITE: 'add reticle() to plugins (also injects connect())',
  /**
   * SvelteKit renders through app.html, so the plugin's HTML injection never fires and connect()
   * comes from the client hook instead. The plugin is still required: it is what stamps
   * data-reticle-source into .svelte components, and without it every verdict on a SvelteKit app
   * comes back with no file:line at all.
   */
  SVELTEKIT:
    'add reticle({ inject: false }) to plugins (stamps data-reticle-source in .svelte components; the client hook connects)',
  /**
   * React Router framework mode renders through its own request handler, so the plugin's HTML
   * injection never fires and connect() comes from the client entry instead. The plugin is still
   * required for the same reason it is under SvelteKit: without it every verdict on the app comes
   * back with no file:line at all.
   */
  REACT_ROUTER: 'add reticle() to plugins (stamps data-reticle-source in .tsx components)',
  /**
   * TanStack Start SSRs its own HTML, so the plugin's HTML injection never fires and connect()
   * comes from a client effect instead. `inject: false` is load-bearing honesty: leaving the
   * default would keep reporting "also injects connect()" for a transform that never runs.
   * The plugin is still required for the same reason it is under SvelteKit: without it every
   * verdict on the app comes back with no file:line at all.
   */
  TANSTACK_START:
    'add reticle({ inject: false }) to plugins (stamps data-reticle-source; Start SSRs its own HTML so connect() cannot come from the plugin)',
} as const;

const CAPABILITIES_TITLE = StepTitle.CAPABILITIES;

/**
 * The one step `init` genuinely cannot finish, addressed to the AGENT reading this report.
 *
 * It used to read "Capabilities are empty until you edit that file" and describe the consequence to
 * a human — homework, in a report a human mostly does not read, naming no file to open and no thing
 * to look for. The agent that ran `init` is right there, has the codebase, and can finish this in
 * the same minute; what it needed was the specific instruction, not the rationale.
 *
 * What is left is exactly what could not be PROVEN from source: which atoms/actor/queryClient an
 * adapter-wrapped store should be built from, and which elements matter enough to name. `init`
 * emits nothing it cannot prove, because a wrong import here throws on every dev page load — worse
 * than an empty file.
 */
const CAPABILITIES_TODO_TITLE = StepTitle.CAPABILITIES_TODO;

export function capabilitiesTodo(path: string, stores: readonly string[]): string {
  return (
    `This app's state lives in a library nothing in the running app points at, so it is the one ` +
    `thing Reticle cannot find for itself — reticle_state will not see it until you say where it ` +
    `is.\n` +
    `Do this now, before driving anything:\n` +
    `  1. In ${path}, uncomment the suggested line and complete it: ${stores.join('; ')}.\n` +
    `  2. Prove it: drive one flow and check reticle_state returns your key. An empty state read ` +
    `means the line is still not doing anything, whatever else went green.`
  );
}

/**
 * The dev module carrying `registerCapabilities` / `registerStore`.
 *
 * Without it every app came up `hasCapabilities: false` with a `reticle_state` holding nothing but
 * `__reticle_renders` — the state-truth read was unavailable on every app out of the box. Written
 * only when absent, because it is the one generated file a user is expected to EDIT.
 */
/**
 * Is there state left that ONLY the app can hand over?
 *
 * This used to ask a much bigger question — "does the generated file register anything at all?" —
 * and fired on almost every install, because almost every install generated a file whose testids
 * and stores were both empty. The answer was homework: go read the source, uncomment a line, add
 * data-testid attributes, then drive to prove it. Several turns, on every onboarding.
 *
 * Two of those three are no longer anyone's homework. Testids are read from the live DOM, and a
 * store passed through a React context provider (Redux, TanStack Query) is discovered and
 * registered on the first commit. What is left is the genuinely unreachable case: a module-scope
 * store, or one needing an argument only the source supplies — Zustand, Jotai atoms, an XState
 * actor. Nothing in the running app points at those, so the notice still has to fire, and it now
 * fires ONLY there.
 *
 * `wired` are stores init resolved and wrote a live `registerStore` call for. Hints are not
 * registrations: they land in the file as a commented line, and counting one as a registration
 * silences the notice whose whole purpose is to say "act on the hint".
 */
export function needsManualStore(hints: readonly string[], wired: readonly unknown[]): boolean {
  return hints.length > 0 && 0 === wired.length;
}

export function capabilitiesStep(input: PlanInput, path: string = VITE_DEV_MODULE_PATH): Step[] {
  if (true === input.viteDevModuleExists) {
    return [
      {
        title: CAPABILITIES_TITLE,
        target: path,
        status: StepStatus.ALREADY,
        detail: 'file exists, left alone, it is yours to edit',
      },
    ];
  }
  const testids = input.testids ?? [];
  const stores = input.storeHints ?? [];
  const wired = input.foundStores ?? [];
  // Testids no longer need counting here. They are read from the live DOM at announce time, so a
  // number printed at install time would be a stale claim about a codebase that is about to change —
  // which is exactly what "no data-testid values yet" used to be on an app whose testids arrive with
  // a lazy route.
  const found = 'testids read from the live DOM';
  // A store we found and WIRED is a registration, so the notice must not fire. A store HINT is not:
  // `stores` holds suggestions, written into the file as a commented line of the form
  // `// import your store, then: registerStore(...)`. Counting a suggestion as a registration let
  // the hint silence the notice whose entire job is to say "act on the hint".
  //
  // Measured against a real product UI (rowy — 70+ deps, jotai, a whole src/atoms tree): init
  // detected jotai, offered one commented line, emitted NO notice, and wrote
  // `registerCapabilities({ testids: [], signals: [], stores: [] })`. So `hasCapabilities` stayed
  // false, `reticle_state` was empty forever, and the install gate reported "connected: 1,
  // manual ⚠: none". Every check green, state observability zero.
  //
  // jotai is still exactly that case. A Redux or TanStack app is not, any more: its store rides a
  // context provider and the React adapter registers it on the first commit, so `storeHints` no
  // longer names either one and this notice no longer fires for them.
  const nothingToRegister = needsManualStore(stores, wired);
  return [
    {
      title: CAPABILITIES_TITLE,
      target: path,
      status: StepStatus.APPLY,
      detail: `${found}; ${
        wired.length > 0
          ? `registered ${wired.map((s) => `'${s.key}'`).join(', ')} from your source`
          : stores.length > 0
            ? `store: uncomment the ${String(stores.length)} suggested line(s)`
            : 'no state library detected'
      }`,
      write: {
        path,
        content: viteDevModuleFile(
          testids,
          stores,
          wired,
          input.detection.uiLibrary,
          input.detection.framework,
        ),
      },
      dependsOnInstall: true,
    },
    // The write is real; what it registers is not. `registerCapabilities({ testids: [], signals: [],
    // stores: [] })` registers nothing, so `hasCapabilities` stays false — correctly — and the ✓
    // above reads as if the feature is on. Reported as exactly that confusion: "hasCapabilities false
    // on every session while init said ✓ Capabilities + store".
    //
    // Beside the write rather than replacing it, for two reasons: only APPLY steps are written
    // (run.ts), and SKILL.md tells the reader to skip ✓ lines — so a caveat carried on the ✓ is a
    // caveat nobody reads.
    ...(nothingToRegister
      ? [
          {
            title: CAPABILITIES_TODO_TITLE,
            target: path,
            status: StepStatus.NOTICE,
            detail: capabilitiesTodo(path, stores),
          } satisfies Step,
        ]
      : []),
  ];
}

export function viteSteps(
  input: PlanInput,
  detail: string = VITE_PLUGIN_DETAIL.VITE,
  inject = true,
): Step[] {
  // Capabilities are independent of whether the config needed patching. Attaching them to the APPLY
  // branch meant a re-run on an already-wired app silently never created the module.
  return [...viteConfigSteps(input, detail, inject), ...capabilitiesStep(input)];
}

function viteConfigSteps(input: PlanInput, detail: string, inject = true): Step[] {
  const cfg = input.viteConfig;
  const port = input.options.port;
  // Stamp `data-reticle-source` unless this app renders through a non-DOM React reconciler, where a
  // lowercase JSX tag is not an element and the stamp crashes the app at commit time. See
  // `Detection.customReconciler`.
  const stampSource = true !== input.detection?.customReconciler;
  // An explicit "not here" is not an invitation. `init` runs unattended in a repo it has just met,
  // and it was reported adding the plugin to an app whose config said Reticle was deliberately
  // excluded. A NOTICE rather than a ⚠: opting out is a decision, not something to go and fix.
  if (cfg !== null && hasOptOut(cfg.source)) {
    return [
      {
        title: StepTitle.VITE_PLUGIN,
        target: cfg.path,
        status: StepStatus.NOTICE,
        detail: `left alone: this config carries ${OPT_OUT_MARKER}. Remove that marker to instrument this app.`,
      },
    ];
  }
  // Plain Vite runs happily with no config file (`npm create vite`'s vanilla template has none), so
  // make one. Only there: a Vite-based framework's missing config also lost the framework's own
  // plugin, and a file carrying ours alone would not boot the app.
  const plainVite = Framework.VITE === input.detection.framework;
  if (null === cfg) {
    if (!plainVite) {
      return [
        {
          title: StepTitle.VITE_PLUGIN,
          target: 'vite.config',
          status: StepStatus.MANUAL,
          detail: viteManual(port, input.detection.uiLibrary, inject, stampSource),
        },
      ];
    }
    const path = input.detection.typescript ? 'vite.config.ts' : 'vite.config.mjs';
    return [
      {
        title: StepTitle.VITE_PLUGIN,
        target: path,
        status: StepStatus.APPLY,
        detail,
        write: {
          path,
          content: newViteConfig(port, true === input.captureBodies, inject, stampSource),
          expect: [VITE_IMPORT, 'reticle('],
        },
        dependsOnInstall: true,
      },
    ];
  }
  const patch = patchViteConfig(
    cfg.source,
    port,
    true === input.captureBodies,
    inject,
    stampSource,
  );
  if (patch.kind === VitePatchKind.ALREADY) {
    return [
      alreadyOrMovedPort(
        {
          title: StepTitle.VITE_PLUGIN,
          target: cfg.path,
          status: StepStatus.ALREADY,
          detail: 'reticle() already in plugins',
        },
        cfg.source,
        port,
      ),
    ];
  }
  if (patch.kind === VitePatchKind.MANUAL) {
    return [
      {
        title: StepTitle.VITE_PLUGIN,
        target: cfg.path,
        status: StepStatus.MANUAL,
        detail: `${patch.reason}\n\n${viteManual(port, input.detection.uiLibrary, inject, stampSource)}`,
      },
    ];
  }
  return [
    {
      title: StepTitle.VITE_PLUGIN,
      target: cfg.path,
      status: StepStatus.APPLY,
      detail,
      // Both halves, because either alone is a config that does not wire: the import without the
      // call leaves `plugins` untouched, and the call without the import does not build.
      write: { path: cfg.path, content: patch.code, expect: [VITE_IMPORT, 'reticle('] },
      dependsOnInstall: true,
    },
  ];
}

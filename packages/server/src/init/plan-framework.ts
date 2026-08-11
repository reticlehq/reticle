/**
 * How each framework gets wired: the Vite plugin, the three Next files, the SvelteKit client hook.
 * Split out of `plan.ts` — that file is the plan's SHAPE (statuses, ordering, the agent/MCP steps),
 * this one is the per-framework detail, and they grow for different reasons.
 */

import { patchViteConfig, VitePatchKind } from './vite-config.js';
import { patchNextConfig, patchRootLayout, patchPagesApp } from './next-patch.js';
import { patchAstroConfig, patchAstroLayout } from './astro-patch.js';
import {
  CRA_DEV_MODULE_IMPORT,
  CRA_DEV_MODULE_PATH,
  CRA_ENV_PATH,
  TOKEN_VAR,
  craDevModuleFile,
  craEnvPatch,
  craImportPatch,
} from './cra.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import {
  viteManual,
  NEXT_LAYOUT_MANUAL,
  NEXT_LAYOUT_PATH,
  viteDevModuleFile,
  VITE_DEV_MODULE_PATH,
  nextReticleDevFile,
  NEXT_RETICLE_DEV_PATH,
  nextConfigManual,
  svelteKitHooksFile,
  SVELTEKIT_HOOKS_PATH,
  UNVERIFIED_FRAMEWORK_NOTE,
  astroManual,
} from './snippets.js';
import { StepStatus, type PlanInput, type Step } from './plan.js';

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
  SVELTEKIT: 'add reticle() to plugins (stamps data-reticle-source in .svelte components)',
} as const;

const CAPABILITIES_TITLE = 'Capabilities + store';

/**
 * The dev module carrying `registerCapabilities` / `registerStore`.
 *
 * Without it every app came up `hasCapabilities: false` with a `reticle_state` holding nothing but
 * `__reticle_renders` — the state-truth read was unavailable on every app out of the box. Written
 * only when absent, because it is the one generated file a user is expected to EDIT.
 */
function capabilitiesStep(input: PlanInput): Step[] {
  if (true === input.viteDevModuleExists) {
    return [
      {
        title: CAPABILITIES_TITLE,
        target: VITE_DEV_MODULE_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists — left alone, it is yours to edit',
      },
    ];
  }
  const testids = input.testids ?? [];
  const stores = input.storeHints ?? [];
  const found =
    testids.length > 0
      ? `${String(testids.length)} data-testid values`
      : 'no data-testid values yet';
  return [
    {
      title: CAPABILITIES_TITLE,
      target: VITE_DEV_MODULE_PATH,
      status: StepStatus.APPLY,
      detail: `${found}; ${stores.length > 0 ? `store: uncomment the ${String(stores.length)} suggested line(s)` : 'no state library detected'}`,
      write: { path: VITE_DEV_MODULE_PATH, content: viteDevModuleFile(testids, stores) },
      dependsOnInstall: true,
    },
  ];
}

export function viteSteps(input: PlanInput, detail: string = VITE_PLUGIN_DETAIL.VITE): Step[] {
  // Capabilities are independent of whether the config needed patching. Attaching them to the APPLY
  // branch meant a re-run on an already-wired app silently never created the module.
  return [...viteConfigSteps(input, detail), ...capabilitiesStep(input)];
}

function viteConfigSteps(input: PlanInput, detail: string): Step[] {
  const cfg = input.viteConfig;
  const port = input.options.port;
  if (null === cfg) {
    return [
      {
        title: 'Vite plugin',
        target: 'vite.config',
        status: StepStatus.MANUAL,
        detail: viteManual(port),
      },
    ];
  }
  const patch = patchViteConfig(cfg.source, port);
  if (patch.kind === VitePatchKind.ALREADY) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.ALREADY,
        detail: 'reticle() already in plugins',
      },
    ];
  }
  if (patch.kind === VitePatchKind.MANUAL) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.MANUAL,
        detail: `${patch.reason}\n\n${viteManual(port)}`,
      },
    ];
  }
  return [
    {
      title: 'Vite plugin',
      target: cfg.path,
      status: StepStatus.APPLY,
      detail,
      write: { path: cfg.path, content: patch.code },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Turn a conservative source patch into a step: applied when it patched, already when the wiring is
 * there, and the hand-edit instructions when the file shape wasn't one we recognise.
 */
function patchStep(
  title: string,
  path: string,
  patch: SourcePatch,
  applyDetail: string,
  manualDetail: string,
): Step {
  if (patch.kind === PatchKind.ALREADY) {
    return { title, target: path, status: StepStatus.ALREADY, detail: 'already wired' };
  }
  if (patch.kind === PatchKind.MANUAL) {
    return {
      title,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${patch.reason}\n\n${manualDetail}`,
    };
  }
  return {
    title,
    target: path,
    status: StepStatus.APPLY,
    detail: applyDetail,
    write: { path, content: patch.code },
    dependsOnInstall: true,
  };
}

/**
 * Next used to be the ONLY stack with hand edits left over — and both of them fail silently when
 * skipped, so a Next user's app booted, connected to nothing, and said nothing about why. Both are
 * now patched by the same conservative rules the Vite config gets.
 */
export function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devPath = input.nextReticleDevPath ?? NEXT_RETICLE_DEV_PATH;
  const devFile: Step = input.nextReticleDevExists
    ? {
        title: 'ReticleDev component',
        target: devPath,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      }
    : {
        title: 'ReticleDev component',
        target: devPath,
        status: StepStatus.APPLY,
        detail: 'create dev-only connect component',
        write: {
          path: devPath,
          content: nextReticleDevFile(
            input.options.port,
            input.options.projectId,
            input.testids ?? [],
            input.storeHints ?? [],
          ),
        },
        dependsOnInstall: true,
      };

  const configPatch: SourcePatch =
    null === input.nextConfigSource || input.nextConfigSource === undefined
      ? { kind: PatchKind.MANUAL, reason: `no ${configFile} found` }
      : patchNextConfig(input.nextConfigSource);
  const layout = input.nextLayout ?? null;
  // Pages Router mounts through pages/_app, App Router through the root layout — different edits,
  // and picking by path is what stops a Pages app being handed the layout patch that cannot apply.
  const isPagesRouter = layout !== null && /(^|\/)pages\/_app\.[jt]sx?$/.test(layout.path);
  const layoutPatch: SourcePatch =
    null === layout
      ? { kind: PatchKind.MANUAL, reason: 'no root layout (app/layout.tsx) or pages/_app found' }
      : isPagesRouter
        ? patchPagesApp(layout.source, input.nextReticleDevImport)
        : patchRootLayout(layout.source);

  return [
    devFile,
    patchStep(
      'Next config (withReticle)',
      configFile,
      configPatch,
      'wrap the export in withReticle (source mapping, dev-only)',
      nextConfigManual(configFile),
    ),
    patchStep(
      'Mount ReticleDev',
      layout?.path ?? NEXT_LAYOUT_PATH,
      layoutPatch,
      'mount <ReticleDev /> in the root layout (dev-only)',
      NEXT_LAYOUT_MANUAL,
    ),
  ];
}

/**
 * SvelteKit is WIRED but not SUPPORTED, and the plan says so out loud.
 *
 * There is no SvelteKit app in `apps/` and no CI gate for one, so nothing proves this hook still
 * registers a session — every other framework init offers (React, Next, Remix, Astro) has both. The
 * wiring is real and may well work; what is missing is anything that would tell us when it stops.
 * Silently emitting it reads as a support claim, which is the thing this project exists to not do.
 */
/**
 * Create React App: the connect goes in `src/index.tsx`, the token in `.env.development.local`.
 *
 * The previous plan pointed at `index.html`, which cannot work — CRA's is a static template the
 * bundler never processes for modules. Reported from a real cra-redux-saga app.
 */
export function craSteps(input: PlanInput): Step[] {
  const entry = input.craEntry ?? null;
  const steps: Step[] = [
    {
      title: 'Reticle connect module',
      target: CRA_DEV_MODULE_PATH,
      status: StepStatus.APPLY,
      detail: 'create the dev-only connect (CRA cannot inject through public/index.html)',
      write: {
        path: CRA_DEV_MODULE_PATH,
        content: craDevModuleFile(input.options.port, input.options.projectId),
      },
      dependsOnInstall: true,
    },
  ];
  const token = input.pairingToken ?? '';
  const env = craEnvPatch(input.craEnv ?? null, token);
  if (env !== null) {
    steps.push({
      title: 'Pairing token',
      target: CRA_ENV_PATH,
      status: StepStatus.APPLY,
      // REACT_APP_* is the only thing CRA inlines into browser code; without the token the bridge
      // refuses the connection and no session appears. Say the file is gitignored HERE, at the one
      // moment someone is looking: the token is per-machine and cannot travel, so every teammate
      // has to run init once or their clone is dead with no explanation.
      detail: `set ${TOKEN_VAR} (the only channel CRA inlines) — ${CRA_ENV_PATH} is gitignored, so each teammate must run \`reticle init\` on their own machine`,
      write: { path: CRA_ENV_PATH, content: env },
    });
  } else if ('' === token) {
    // No daemon has ever run here, so there is no token to inline. Omitting the step entirely made
    // init report all-green for an app that could never pair.
    steps.push({
      title: 'Pairing token',
      target: CRA_ENV_PATH,
      status: StepStatus.MANUAL,
      // `reticle serve`, not `reticle start` — the latter is not a verb this CLI dispatches, and
      // this message is read by someone whose app boots and never pairs. Handing them a command
      // that errors is a second dead end on the first.
      detail: `no pairing token yet — the daemon writes one on first run. Start it with \`reticle serve\` (or let your agent run \`reticle mcp\`), then \`reticle init\` again to write ${TOKEN_VAR}`,
    });
  }
  if (null === entry) {
    steps.push({
      title: 'Connect snippet (CRA)',
      target: 'src/index.tsx',
      status: StepStatus.MANUAL,
      detail: `Add \`${CRA_DEV_MODULE_IMPORT}\` to your app entry (src/index.tsx or src/index.js), after the existing imports.`,
    });
    return steps;
  }
  const patched = craImportPatch(entry.source);
  steps.push(
    null === patched
      ? {
          title: 'Connect snippet (CRA)',
          target: entry.path,
          status: StepStatus.ALREADY,
          detail: 'already imported',
        }
      : {
          title: 'Connect snippet (CRA)',
          target: entry.path,
          status: StepStatus.APPLY,
          detail: 'import the dev-only connect module',
          write: { path: entry.path, content: patched },
          dependsOnInstall: true,
        },
  );
  return steps;
}

export function svelteKitSteps(input: PlanInput): Step[] {
  const unverified: Step = {
    title: 'SvelteKit is UNVERIFIED',
    target: SVELTEKIT_HOOKS_PATH,
    status: StepStatus.NOTICE,
    detail: UNVERIFIED_FRAMEWORK_NOTE,
  };
  // SvelteKit can't use the Vite-plugin injection (it renders via app.html) — wire a client hook
  // that SvelteKit runs on startup, which is the path that can register a session at all.
  if (true === input.svelteKitHooksExists) {
    return [
      unverified,
      {
        title: 'Reticle client hook',
        target: SVELTEKIT_HOOKS_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      },
    ];
  }
  return [
    unverified,
    {
      title: 'Reticle client hook',
      target: SVELTEKIT_HOOKS_PATH,
      status: StepStatus.APPLY,
      detail: 'create dev-only client connect (SvelteKit renders via app.html)',
      write: {
        path: SVELTEKIT_HOOKS_PATH,
        content: svelteKitHooksFile(input.options.port, input.options.projectId),
      },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Astro: the config define + build target, and the connect script in ONE layout.
 *
 * Astro was the last gated stack left printing a recipe it did not apply. It still falls back to the
 * printed one whenever the choice is not obvious — no config, no single layout, or a shape the
 * patchers do not fully recognise — because which page or layout to instrument is a real decision
 * and a half-edited build config is worse than a documented manual step.
 */
export function astroSteps(input: PlanInput): Step[] {
  const config = input.astroConfig ?? null;
  const layout = input.astroLayout ?? null;
  const manual = astroManual(input.options.port, input.options.projectId, layout?.path);
  if (null === config || null === layout) {
    return [
      {
        title: 'Connect snippet (Astro)',
        // Name what is actually there. `astro.config + layout` pointed at a layout this project may
        // not have — reported on a fixture with only src/pages/index.astro.
        target:
          null === layout ? 'astro.config + a page (no layout found)' : 'astro.config + layout',
        status: StepStatus.MANUAL,
        detail: manual,
      },
    ];
  }
  // ATOMIC. The connect snippet is useless without the config: the token is inlined by the config,
  // so a layout patched on its own gives an app that dials the bridge and is refused. Measured on a
  // real fixture — config ⚠, layout ✓ — which reads as one step done and one caveat when it is
  // actually a guaranteed non-connection. If either half cannot be applied, BOTH go manual with the
  // single recipe that does the whole job.
  const manualWithLayout = astroManual(input.options.port, input.options.projectId, layout.path);
  const configPatch = patchAstroConfig(config.source);
  const layoutPatch = patchAstroLayout(layout.source, input.options.port, input.options.projectId);
  if (configPatch.kind === PatchKind.MANUAL || layoutPatch.kind === PatchKind.MANUAL) {
    return [
      {
        title: 'Connect snippet (Astro)',
        target: `${config.path} + ${layout.path}`,
        status: StepStatus.MANUAL,
        detail: manualWithLayout,
      },
    ];
  }
  return [
    patchStep(
      'Astro config (token + build target)',
      config.path,
      configPatch,
      'inline the pairing token and raise build.target to es2022',
      manualWithLayout,
    ),
    patchStep(
      'Connect snippet (Astro)',
      layout.path,
      layoutPatch,
      'add the dev-only connect <script> before </body>',
      manualWithLayout,
    ),
  ];
}

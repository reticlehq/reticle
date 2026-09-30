/**
 * How each framework gets wired: the three Next files, the SvelteKit client hook, CRA, Nuxt, Astro
 * and the rest. `plan.ts` is the plan's SHAPE (statuses, ordering, the agent/MCP steps); this is the
 * per-framework detail, and they grow for different reasons. The Vite plugin and the capabilities
 * module every Vite-based stack shares live in `plan-vite.ts`.
 */

import { bridgeWsUrl } from '@reticlehq/core';
import { patchNextConfig, patchRootLayout, patchPagesApp } from '@/patch/next-patch.js';
import {
  ASTRO_ENV_DTS_PATH,
  ASTRO_RETICLE_DEV_PATH,
  astroReticleDevFile,
  patchAstroConfig,
  patchAstroEnvDts,
  patchAstroLayout,
} from '@/patch/astro-patch.js';
import {
  CRA_DEV_MODULE_IMPORT,
  CRA_ENV_PATH,
  CRA_TOKEN_PER_MACHINE_NOTICE,
  TOKEN_VAR,
  craDevModuleFile,
  craDevModulePath,
  craEnvPatch,
  craImportPatch,
} from '@/patch/cra.js';
import { PatchKind, type SourcePatch } from '@/patch/patch-kind.js';
import {
  NEXT_LAYOUT_MANUAL,
  NEXT_LAYOUT_PATH,
  nextReticleDevFile,
  NEXT_RETICLE_DEV_PATH,
  nextConfigManual,
  svelteKitHooksFile,
  SVELTEKIT_HOOKS_PATH,
  SVELTEKIT_SETUP_GATED_NOTE,
  astroManual,
  nuxtManual,
  nuxtPluginFile,
  nuxtPluginPath,
  NUXT_PLUGIN_NOTICE,
  webpack4TranspileNote,
  WEBPACK4_REACT_SCRIPTS_MAJOR,
  reactRouterEntryFile,
  reactRouterEntryPatch,
  REACT_ROUTER_ENTRY_PATH,
  UNVERIFIED_TANSTACK_START_NOTE,
  htmlManual,
} from '@/patch/snippets.js';
import { StepStatus, type PlanInput, type Step } from './plan-types.js';
import { StepTitle } from './connect-steps.js';
import {
  patchTanstackStartRoot,
  tanstackStartConnectFile,
  tanstackStartConnectPath,
  tanstackStartManual,
  TANSTACK_START_ROOT_PATH,
} from '@/patch/tanstack-start.js';
import { patchNuxtConfig } from '@/patch/nuxt-patch.js';
import { alreadyOrMovedPort } from './port-steps.js';
import { capabilitiesTodo, needsManualStore } from './plan-vite.js';
import { HTML_INDEX_PATH, hasStaticSnippet } from '@/patch/static-page.js';

/**
 * Turn a conservative source patch into a step: applied when it patched, already when the wiring is
 * there, and the hand-edit instructions when the file shape wasn't one we recognise.
 */
export function patchStep(
  title: StepTitle,
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
/** The env var withReticle sets from the discovered daemon, and the component must read. */
const NEXT_DAEMON_URL_ENV = 'NEXT_PUBLIC_RETICLE_URL';

/**
 * The two-line edit that unfreezes an existing install's port.
 *
 * Stated as the edit rather than as a problem, because the reader is an agent that can apply it in
 * one write and is otherwise going to ask what to do.
 */
const NEXT_DEV_FILE_STALE_DETAIL =
  'predates daemon discovery, so it dials the port init saw when it ran. In this file add ' +
  '`const url = process.env.NEXT_PUBLIC_RETICLE_URL;` and spread `...(url ? { url } : {})` into ' +
  'reticle.connect(), after any url already there. Nothing else needs to change.';

export function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devPath = input.nextReticleDevPath ?? NEXT_RETICLE_DEV_PATH;
  // An install that predates daemon discovery has a component that never reads the discovered URL,
  // so it keeps dialling whatever port `init` saw on the day it ran. Re-running `init` used to call
  // that "file exists" and move on, which is why the defect survives an upgrade. Named as work.
  //
  // Never overwritten: this file is the one an app owner edits — registered stores, capabilities,
  // their own signals. Rewriting it to fix two lines would take the rest with it. Undefined source
  // means it was not read, and an unread file stays ALREADY rather than becoming invented work.
  const devStale =
    true === input.nextReticleDevExists &&
    'string' === typeof input.nextReticleDevSource &&
    !input.nextReticleDevSource.includes(NEXT_DAEMON_URL_ENV);
  const devFile: Step = input.nextReticleDevExists
    ? devStale
      ? {
          title: StepTitle.RETICLE_DEV_COMPONENT,
          target: devPath,
          status: StepStatus.MANUAL,
          detail: NEXT_DEV_FILE_STALE_DETAIL,
        }
      : alreadyOrMovedPort(
          {
            title: StepTitle.RETICLE_DEV_COMPONENT,
            target: devPath,
            status: StepStatus.ALREADY,
            detail: 'file exists',
          },
          input.nextReticleDevSource,
          input.options.port,
        )
    : {
        title: StepTitle.RETICLE_DEV_COMPONENT,
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
            // Next's dev module is not a sibling of `src/` — its imports are resolved from wherever
            // the component actually lands (`app/`, or `src/app/` in a --src-dir app).
            input.nextFoundStores ?? [],
          ),
        },
        dependsOnInstall: true,
      };

  const configPatch: SourcePatch =
    null === input.nextConfigSource || input.nextConfigSource === undefined
      ? { kind: PatchKind.MANUAL, reason: `no ${configFile} found` }
      : patchNextConfig(input.nextConfigSource, true !== input.detection?.customReconciler);
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

  // The same question the Vite path asks. Skipped when the module already exists: its contents are
  // the user's, and re-nagging about a file we did not write is noise.
  const nextTodo: Step[] =
    true !== input.nextReticleDevExists &&
    needsManualStore(input.storeHints ?? [], input.nextFoundStores ?? [])
      ? [
          {
            title: StepTitle.CAPABILITIES_TODO,
            target: devPath,
            status: StepStatus.NOTICE,
            detail: capabilitiesTodo(devPath, input.storeHints ?? []),
          },
        ]
      : [];

  return [
    devFile,
    ...nextTodo,
    patchStep(
      StepTitle.NEXT_CONFIG,
      configFile,
      configPatch,
      'wrap the export in withReticle (source mapping, dev-only)',
      nextConfigManual(configFile, true !== input.detection?.customReconciler),
    ),
    patchStep(
      StepTitle.MOUNT_RETICLE_DEV,
      layout?.path ?? NEXT_LAYOUT_PATH,
      layoutPatch,
      'mount <ReticleDev /> in the root layout (dev-only)',
      NEXT_LAYOUT_MANUAL,
    ),
  ];
}

/**
 * The one failure `init` cannot otherwise see: the bundler will not parse our SDK.
 *
 * Every check in this report passes on a react-scripts 4 app -- the package installs, the entry
 * import is written, the token is inlined -- and then `npm start` dies with a syntax error inside
 * `@reticlehq/browser/dist/index.js`, a file the user did not write, naming nothing about Reticle
 * (#680). A green report over a build that cannot compile is the same class of lie as a green report
 * over an app that cannot connect.
 *
 * FIRST in the CRA step list, deliberately: it decides whether any of the steps below it can run at
 * all.
 */
function webpack4Step(input: PlanInput): Step[] {
  const major = input.detection.reactScriptsMajor;
  if (major === undefined || major >= WEBPACK4_REACT_SCRIPTS_MAJOR) return [];
  return [
    {
      title: `react-scripts ${String(major)} cannot parse the SDK`,
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: webpack4TranspileNote(major),
    },
  ];
}

/**
 * Create React App: the connect goes in `src/index.tsx`, the token in `.env.development.local`.
 *
 * The previous plan pointed at `index.html`, which cannot work — CRA's is a static template the
 * bundler never processes for modules. Reported from a real cra-redux-saga app.
 */
export function craSteps(input: PlanInput): Step[] {
  const entry = input.craEntry ?? null;
  // Match the project language the same way Next does (#675): a JS CRA app cannot resolve `.ts`.
  const modulePath = craDevModulePath(input.detection.typescript);
  const steps: Step[] = [
    ...webpack4Step(input),
    {
      title: StepTitle.CONNECT_MODULE,
      target: modulePath,
      status: StepStatus.APPLY,
      detail: 'create the dev-only connect (CRA cannot inject through public/index.html)',
      write: {
        path: modulePath,
        content: craDevModuleFile(input.options.port, input.options.projectId, {
          typescript: input.detection.typescript,
          testids: input.testids ?? [],
        }),
      },
      dependsOnInstall: true,
    },
  ];
  const token = input.pairingToken ?? '';
  // The daemon that is live NOW, not the one baked into the module at first install. CRA has no
  // build hook, so this is refreshed by re-running `init` rather than by starting the dev server.
  const env = craEnvPatch(
    input.craEnv ?? null,
    token,
    input.options.port === undefined ? undefined : bridgeWsUrl(input.options.port),
  );
  if (env !== null) {
    steps.push({
      title: StepTitle.PAIRING_TOKEN,
      target: CRA_ENV_PATH,
      status: StepStatus.APPLY,
      // REACT_APP_* is the only thing CRA inlines into browser code; without the token the bridge
      // refuses the connection and no session appears. Say the file is gitignored HERE, at the one
      // moment someone is looking: the token is per-machine and cannot travel, so every teammate
      // has to run init once or their clone is dead with no explanation.
      detail: `set ${TOKEN_VAR} (the only channel CRA inlines) — ${CRA_ENV_PATH} is gitignored, so each teammate must run \`reticle init\` on their own machine`,
      write: { path: CRA_ENV_PATH, content: env },
    });
    // Beside the write, not inside it. A ✓ line is one SKILL.md tells the reader to skip, and this
    // is the fact that decides whether the install works for anyone but the person running it.
    steps.push({
      title: StepTitle.PAIRING_TOKEN_PER_MACHINE,
      target: CRA_ENV_PATH,
      status: StepStatus.NOTICE,
      detail: CRA_TOKEN_PER_MACHINE_NOTICE,
    });
  } else if ('' === token) {
    // No daemon has ever run here, so there is no token to inline. Omitting the step entirely made
    // init report all-green for an app that could never pair.
    steps.push({
      title: StepTitle.PAIRING_TOKEN,
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
      title: StepTitle.CONNECT_SNIPPET_CRA,
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
          title: StepTitle.CONNECT_SNIPPET_CRA,
          target: entry.path,
          status: StepStatus.ALREADY,
          detail: 'already imported',
        }
      : {
          title: StepTitle.CONNECT_SNIPPET_CRA,
          target: entry.path,
          status: StepStatus.APPLY,
          detail: 'import the dev-only connect module',
          write: { path: entry.path, content: patched },
          dependsOnInstall: true,
        },
  );
  return steps;
}

/**
 * Nuxt: the client plugin written, and the config patched so it can pair.
 *
 * This used to be one MANUAL step carrying the whole recipe, so `init` ended on a ⚠ and exited 1 —
 * a correct recipe nobody applies is the same outcome as no recipe. What it could not do until now
 * was the pairing token: the bridge requires one even on localhost, nothing in a browser can read
 * the file it lives in, and Nuxt loads no plugin of ours that could inject it. `nuxt.config`'s
 * `vite.define` is the one place that can, which is also where the journal watch-ignore goes.
 *
 * ATOMIC, for the reason `astroSteps` is: a plugin written beside a config we could not patch is an
 * app that dials the bridge and is refused, reported as one green step and one caveat when it is a
 * guaranteed non-connection. If the config cannot be patched, BOTH halves go back to the recipe.
 */
export function nuxtSteps(input: PlanInput): Step[] {
  const config = input.nuxtConfig ?? null;
  const pluginPath = nuxtPluginPath(true === input.nuxtHasAppDir);
  const manual: Step[] = [
    {
      title: StepTitle.CONNECT_SNIPPET_NUXT,
      target: null === config ? 'nuxt.config + a client plugin' : `${config.path} + ${pluginPath}`,
      status: StepStatus.MANUAL,
      detail: nuxtManual(input.options.port, input.options.projectId),
    },
  ];
  if (null === config) return manual;
  const configPatch = patchNuxtConfig(config.source, input.viteMajor ?? null);
  if (configPatch.kind === PatchKind.MANUAL) return manual;
  const notice: Step = {
    title: StepTitle.NUXT_RESTART,
    target: pluginPath,
    status: StepStatus.NOTICE,
    detail: NUXT_PLUGIN_NOTICE,
  };
  // Never overwritten: this file is the one an app owner edits — their registered stores, their own
  // capabilities. Rewriting it would take those with it.
  const plugin: Step =
    true === input.nuxtPluginExists
      ? alreadyOrMovedPort(
          {
            title: StepTitle.CONNECT_SNIPPET_NUXT,
            target: pluginPath,
            status: StepStatus.ALREADY,
            detail: 'file exists',
          },
          input.nuxtPluginSource,
          input.options.port,
        )
      : {
          title: StepTitle.CONNECT_SNIPPET_NUXT,
          target: pluginPath,
          status: StepStatus.APPLY,
          detail: 'create the dev-only client plugin (Nuxt renders its own HTML)',
          write: {
            path: pluginPath,
            content: nuxtPluginFile(
              input.options.port,
              input.options.projectId,
              input.testids ?? [],
            ),
          },
          dependsOnInstall: true,
        };
  return [
    plugin,
    patchStep(
      StepTitle.NUXT_CONFIG,
      config.path,
      configPatch,
      'inline the pairing token and keep the journal out of the watcher',
      nuxtManual(input.options.port, input.options.projectId),
    ),
    // Only when this run changed something Nuxt reads at startup. A re-run that found everything in
    // place, attached to the running server and connected was still told to restart it.
    ...(StepStatus.ALREADY === plugin.status && PatchKind.ALREADY === configPatch.kind
      ? []
      : [notice]),
  ];
}

/**
 * React Router framework mode: the client entry, WRITTEN.
 *
 * #678 happened here — every step reported green and the daemon showed zero sessions for 20+
 * minutes, because framework mode renders HTML through its own request handler and the Vite plugin's
 * `transformIndexHtml` injection never fires. The connect has to come from `app/entry.client.tsx`,
 * and that used to be printed as a recipe: `init` exited 0 over an app that could not connect.
 *
 * The file is an OVERRIDE of a default React Router supplies, so when it is absent the generated one
 * carries React Router's own default entry as well as the import — a file containing only our import
 * would replace that default with one that never hydrates. When it is present, one line is added to
 * it and nothing else is touched.
 */
export function reactRouterSteps(
  input: PlanInput,
  // Remix v2 is the same framework under its old name and takes the same entry, with its own
  // default hydration (`RemixBrowser`) and its own title — see plan-remix.ts.
  title: StepTitle = StepTitle.CONNECT_SNIPPET_REACT_ROUTER,
  newEntry: () => string = reactRouterEntryFile,
): Step[] {
  const detail =
    'connect from the client entry — framework mode renders HTML through its own request handler, ' +
    "so the Vite plugin's index.html injection never fires";
  const existing = input.reactRouterEntrySource ?? null;
  if (true !== input.reactRouterEntryExists || null === existing) {
    return [
      {
        title,
        target: REACT_ROUTER_ENTRY_PATH,
        status: StepStatus.APPLY,
        detail: `create the dev-only ${detail}`,
        write: { path: REACT_ROUTER_ENTRY_PATH, content: newEntry() },
        dependsOnInstall: true,
      },
    ];
  }
  const patched = reactRouterEntryPatch(existing);
  return [
    null === patched
      ? {
          title,
          target: REACT_ROUTER_ENTRY_PATH,
          status: StepStatus.ALREADY,
          detail: 'already imported',
        }
      : {
          title,
          target: REACT_ROUTER_ENTRY_PATH,
          status: StepStatus.APPLY,
          detail: `add one line to ${detail}`,
          write: { path: REACT_ROUTER_ENTRY_PATH, content: patched },
          dependsOnInstall: true,
        },
  ];
}

/**
 * TanStack Start: a client connect component, written, and rendered in the root document.
 *
 * ATOMIC, like Astro: the component on disk with nothing rendering it is a guaranteed
 * non-connection, so when the root cannot be patched BOTH halves go back to the recipe.
 */
export function tanstackStartSteps(input: PlanInput): Step[] {
  const root = input.tanstackStartRoot ?? TANSTACK_START_ROOT_PATH;
  const unverified: Step = {
    title: StepTitle.TANSTACK_START_UNVERIFIED,
    target: root,
    status: StepStatus.NOTICE,
    detail: UNVERIFIED_TANSTACK_START_NOTE,
  };
  const recipe = tanstackStartManual(input.options.port, input.options.projectId, root);
  const source = input.tanstackStartRootSource ?? null;
  const patch: SourcePatch =
    null === source
      ? { kind: PatchKind.MANUAL, reason: `could not read ${root}` }
      : patchTanstackStartRoot(source, root);
  const rendered = patchStep(
    StepTitle.CONNECT_SNIPPET_TANSTACK_START,
    root,
    patch,
    'render <ReticleConnect /> before <Scripts /> in the root document',
    recipe,
  );
  if (PatchKind.MANUAL === patch.kind) return [unverified, rendered];
  const title = StepTitle.TANSTACK_START_CONNECT_COMPONENT;
  const path = tanstackStartConnectPath(root);
  const content = tanstackStartConnectFile(input.options.port, input.options.projectId, root);
  const component: Step =
    true === input.tanstackStartConnectExists
      ? // "file exists" used to end it without reading the port inside, so a re-run with a new
        // `--port` left the page dialling the daemon that had moved.
        alreadyOrMovedPort(
          { title, target: path, status: StepStatus.ALREADY, detail: 'file exists' },
          input.tanstackStartConnectSource,
          input.options.port,
        )
      : {
          title,
          target: path,
          status: StepStatus.APPLY,
          detail: 'create the dev-only client connect (Start SSRs its own HTML)',
          write: { path, content },
          dependsOnInstall: true,
        };
  return [unverified, component, rendered];
}

export function svelteKitSteps(input: PlanInput): Step[] {
  const unverified: Step = {
    title: StepTitle.SVELTEKIT_SETUP_GATED,
    target: SVELTEKIT_HOOKS_PATH,
    status: StepStatus.NOTICE,
    detail: SVELTEKIT_SETUP_GATED_NOTE,
  };
  // SvelteKit can't use the Vite-plugin injection (it renders via app.html) — wire a client hook
  // that SvelteKit runs on startup, which is the path that can register a session at all.
  if (true === input.svelteKitHooksExists) {
    return [
      unverified,
      alreadyOrMovedPort(
        {
          title: StepTitle.CLIENT_HOOK,
          target: SVELTEKIT_HOOKS_PATH,
          status: StepStatus.ALREADY,
          detail: 'file exists',
        },
        input.svelteKitHooksSource,
        input.options.port,
      ),
    ];
  }
  return [
    unverified,
    {
      title: StepTitle.CLIENT_HOOK,
      target: SVELTEKIT_HOOKS_PATH,
      status: StepStatus.APPLY,
      detail: 'create dev-only client connect (SvelteKit renders via app.html)',
      write: {
        path: SVELTEKIT_HOOKS_PATH,
        content: svelteKitHooksFile(
          input.options.port,
          input.options.projectId,
          input.detection.uiLibrary,
          input.testids ?? [],
        ),
      },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Astro: the config build target, and the connect script (with the pairing token) in ONE layout.
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
        title: StepTitle.CONNECT_SNIPPET_ASTRO,
        // Name what is actually there. `astro.config + layout` pointed at a layout this project may
        // not have — reported on a fixture with only src/pages/index.astro.
        target:
          null === layout ? 'astro.config + a page (no layout found)' : 'astro.config + layout',
        status: StepStatus.MANUAL,
        detail: manual,
      },
    ];
  }
  // ATOMIC. The connect snippet is useless without the config: without `build.target: 'es2022'`
  // Astro down-levels the SDK and the dynamic import dies, and without `optimizeDeps.include` the
  // first load 404s the hashed module. The token itself now lives in the layout frontmatter (#1008),
  // but a layout patched on its own still cannot connect. Measured on a real fixture — config ⚠,
  // layout ✓ — which reads as one step done and one caveat when it is actually a guaranteed
  // non-connection. If either half cannot be applied, BOTH go manual with the single recipe.
  const manualWithLayout = astroManual(input.options.port, input.options.projectId, layout.path);
  const configPatch = patchAstroConfig(config.source, input.viteMajor ?? null);
  const layoutPatch = patchAstroLayout(layout.source, layout.path);
  if (configPatch.kind === PatchKind.MANUAL || layoutPatch.kind === PatchKind.MANUAL) {
    return [
      {
        title: StepTitle.CONNECT_SNIPPET_ASTRO,
        target: `${config.path} + ${layout.path}`,
        status: StepStatus.MANUAL,
        detail: manualWithLayout,
      },
    ];
  }
  const envPatch = patchAstroEnvDts(input.astroEnvDts ?? null);
  const existingDev = input.astroReticleDev ?? null;
  const devAlready = 'string' === typeof existingDev && existingDev.includes('reticle.connect');
  const devStep: Step = devAlready
    ? {
        title: StepTitle.ASTRO_RETICLE_DEV,
        target: ASTRO_RETICLE_DEV_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists, left alone',
      }
    : {
        title: StepTitle.ASTRO_RETICLE_DEV,
        target: ASTRO_RETICLE_DEV_PATH,
        status: StepStatus.APPLY,
        detail: 'write the local connect module (static SDK import, token from <meta>)',
        write: {
          path: ASTRO_RETICLE_DEV_PATH,
          content: astroReticleDevFile(
            input.options.port,
            input.options.projectId,
            input.detection.uiLibrary,
            input.testids ?? [],
          ),
        },
        dependsOnInstall: true,
      };
  return [
    patchStep(
      StepTitle.ASTRO_CONFIG,
      config.path,
      configPatch,
      'raise build.target to es2022 and keep .reticle/ out of the watcher',
      manualWithLayout,
    ),
    patchStep(
      StepTitle.CONNECT_SNIPPET_ASTRO,
      layout.path,
      layoutPatch,
      'add the pairing-token <meta> and a script that statically imports ReticleDev',
      manualWithLayout,
    ),
    devStep,
    // Declares the Vite define names so `astro check` (create-astro's default build) can see them
    // (#677). Independent of the two halves above: even an ALREADY config/layout still needs this
    // when the env file was never written.
    patchStep(
      StepTitle.ASTRO_ENV_DTS,
      ASTRO_ENV_DTS_PATH,
      envPatch,
      'declare window.__RETICLE_TOKEN__ / __RETICLE_ROOT__ for astro check',
      manualWithLayout,
    ),
  ];
}

/**
 * The plain-HTML path: no bundler to hook, so the connect snippet is printed for a hand edit.
 *
 * A function of its own, and NOT a fallthrough. Every framework is sent here on purpose or not at
 * all — a member of `Framework` with no adapter entry is a compile error in `FRAMEWORK_ADAPTERS`,
 * where the if/else chain this replaced used to hand it these instructions silently.
 */
export function htmlSteps(input: PlanInput): Step[] {
  // Read the page before calling the step undone. It used to be MANUAL unconditionally, so a re-run
  // over a page that already connects said "This app will NOT connect until the ⚠ step".
  const index = input.htmlIndexSource ?? null;
  if (null !== index && hasStaticSnippet(index)) {
    return [
      alreadyOrMovedPort(
        {
          title: StepTitle.CONNECT_SNIPPET,
          target: HTML_INDEX_PATH,
          status: StepStatus.ALREADY,
          detail: 'index.html already loads the Reticle SDK',
        },
        index,
        input.options.port,
      ),
    ];
  }
  return [
    {
      title: StepTitle.CONNECT_SNIPPET,
      target: HTML_INDEX_PATH,
      status: StepStatus.MANUAL,
      detail: htmlManual(
        input.options.port,
        input.options.projectId,
        input.pairingToken,
        input.detection.uiLibrary,
      ),
    },
  ];
}

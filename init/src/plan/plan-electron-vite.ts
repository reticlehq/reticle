/**
 * The plan's Electron half: the renderer plugin, capabilities, and the two Electron steps — for
 * electron-vite and for Electron Forge's Vite template, which differ only in where the renderer's
 * Vite config lives.
 *
 * Its own module because these are the only frameworks whose wiring reaches outside the renderer,
 * into a preload and a main process the web frameworks have no equivalent of.
 */

import { StepStatus, type PlanInput, type Step } from './plan-types.js';
import { StepTitle } from './connect-steps.js';
import { patchStep } from './plan-framework.js';
import { capabilitiesStep, viteSteps } from './plan-vite.js';
import { alreadyOrMovedPort } from './port-steps.js';
import { patchElectronViteConfig } from '@/patch/electron-vite-patch.js';
import { patchElectronMain, patchElectronPreload } from '@/patch/electron-patch.js';
import { ELECTRON_CAPTURE_FIX, ELECTRON_PRELOAD_FIX } from '@/diagnose/desktop-doctor.js';
import { electronViteManual, ELECTRON_VITE_DEV_MODULE_PATH } from '@/patch/snippets.js';

/**
 * electron-vite: the renderer plugin, then capabilities, then the two Electron halves.
 *
 * The plugin and the Electron steps are independent. A renderer without the preload still
 * connects — it only loses IPC visibility — so they stay separate rather than collapsing to one
 * manual recipe the way Astro's config+layout pair does.
 */
export function electronViteSteps(input: PlanInput): Step[] {
  const port = input.options.port;
  const manual = electronViteManual(port, input.detection.uiLibrary);
  const cfg = input.electronViteConfig ?? null;
  const plugin: Step =
    null === cfg
      ? {
          title: StepTitle.ELECTRON_VITE_PLUGIN,
          target: 'electron.vite.config',
          status: StepStatus.MANUAL,
          detail: manual,
        }
      : alreadyOrMovedPort(
          patchStep(
            StepTitle.ELECTRON_VITE_PLUGIN,
            cfg.path,
            patchElectronViteConfig(cfg.source, port),
            'add reticle({ desktop: true }) to the renderer plugins (also injects connect())',
            manual,
          ),
          cfg.source,
          port,
        );
  return [
    plugin,
    ...capabilitiesStep(input, ELECTRON_VITE_DEV_MODULE_PATH),
    ...electronPreloadStep(input, true),
    ...electronCaptureStep(input),
  ];
}

/**
 * `guarded` is whether the shim may sit behind a dev guard: electron-vite's template runs its preload
 * unsandboxed, Forge's is sandboxed by Electron's default and can only take the static import. See
 * `patchElectronPreload`.
 */
function electronPreloadStep(input: PlanInput, guarded: boolean): Step[] {
  const file = input.electronPreload ?? null;
  if (null === file) {
    return [
      {
        title: StepTitle.ELECTRON_PRELOAD,
        target: 'preload',
        status: StepStatus.MANUAL,
        detail: ELECTRON_PRELOAD_FIX,
      },
    ];
  }
  return [
    patchStep(
      StepTitle.ELECTRON_PRELOAD,
      file.path,
      patchElectronPreload(file.source, file.path, guarded),
      'require the IPC shim as the first line of preload, dev only',
      ELECTRON_PRELOAD_FIX,
    ),
  ];
}

function electronCaptureStep(input: PlanInput): Step[] {
  const file = input.electronMain ?? null;
  if (null === file) {
    return [
      {
        title: StepTitle.ELECTRON_CAPTURE,
        target: 'main',
        status: StepStatus.MANUAL,
        detail: ELECTRON_CAPTURE_FIX,
      },
    ];
  }
  return [
    patchStep(
      StepTitle.ELECTRON_CAPTURE,
      file.path,
      patchElectronMain(file.source, file.path),
      'installReticleCapture on the BrowserWindow so screenshots work',
      ELECTRON_CAPTURE_FIX,
    ),
  ];
}

/**
 * Electron Forge's Vite template: the renderer config, then the same two Electron halves.
 *
 * Forge's renderer config is an ordinary Vite config (`defineConfig({})`), so it is patched by the
 * ordinary Vite patcher — `run.ts` hands it over as `viteConfig` when the framework is Forge.
 *
 * The plugin goes in WITHOUT `desktop: true`. `electron-forge start` serves the renderer through a
 * real Vite dev server, so the plugin's ordinary serve-time injection reaches the window; the flag
 * exists for a packaged renderer driven with no dev server, which is built in a non-production mode
 * on purpose. Without it a packaged Forge app has no connect() in any mode, which is the web default
 * and the safe direction. Measured on a
 * scaffolded Forge 8 app: `tsc --noEmit` and `electron-forge package` both pass after `init`, and the
 * packaged renderer carries no Reticle code.
 */
const FORGE_RENDERER_DETAIL =
  'add reticle() to the renderer plugins — the only one of Forge’s three Vite builds with a ' +
  'document (also injects connect() while `electron-forge start` serves it)';

export function electronForgeSteps(input: PlanInput): Step[] {
  return [
    ...viteSteps(input, FORGE_RENDERER_DETAIL),
    ...electronPreloadStep(input, false),
    ...electronCaptureStep(input),
  ];
}

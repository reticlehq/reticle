/**
 * The plan's electron-vite half: the renderer plugin, capabilities, and the two Electron steps.
 *
 * Its own module rather than more of `plan-framework.ts`, which was at the 1000-line backstop.
 * Cohesive on its own terms: this is the only framework whose wiring reaches outside the renderer,
 * into a preload and a main process that the web frameworks have no equivalent of.
 */

import { StepStatus, type PlanInput, type Step } from './plan.js';
import { StepTitle } from './connect-steps.js';
import { capabilitiesStep, patchStep } from './plan-framework.js';
import { patchElectronViteConfig } from '../patch/electron-vite-patch.js';
import { patchElectronMain, patchElectronPreload } from '../patch/electron-patch.js';
import { ELECTRON_CAPTURE_FIX, ELECTRON_PRELOAD_FIX } from '../diagnose/desktop-doctor.js';
import { electronViteManual, ELECTRON_VITE_DEV_MODULE_PATH } from '../patch/snippets.js';

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
      : patchStep(
          StepTitle.ELECTRON_VITE_PLUGIN,
          cfg.path,
          patchElectronViteConfig(cfg.source, port),
          'add reticle({ desktop: true }) to the renderer plugins (also injects connect())',
          manual,
        );
  return [
    plugin,
    ...capabilitiesStep(input, ELECTRON_VITE_DEV_MODULE_PATH),
    ...electronPreloadStep(input),
    ...electronCaptureStep(input),
  ];
}

function electronPreloadStep(input: PlanInput): Step[] {
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
      patchElectronPreload(file.source, file.path),
      'require the IPC shim as the first line of preload',
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

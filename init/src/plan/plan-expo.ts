/**
 * Expo: the dev-only connect for web, an empty twin for iOS and Android, and the token in
 * `.env.local`. See `patch/expo.ts` for why it takes this shape (#1707).
 */

import { bridgeWsUrl } from '@reticlehq/core';
import {
  EXPO_ENV_PATH,
  EXPO_TOKEN_PER_MACHINE_NOTICE,
  EXPO_TOKEN_VAR,
  expoEnvPatch,
  expoImportLine,
  expoImportPatch,
  expoNativeModuleFile,
  expoNativeModulePath,
  expoWebModuleFile,
  expoWebModulePath,
} from '@/patch/expo.js';
import { StepTitle } from './connect-steps.js';
import { StepStatus, type PlanInput, type Step } from './plan-types.js';

/** Where the manual step points when no entry is found: the file a new expo-router app has. */
const EXPO_DEFAULT_ENTRY = 'app/_layout.tsx';

/** The token half: written when the daemon has minted one, a manual step when it has not yet. */
function expoTokenSteps(input: PlanInput): Step[] {
  const token = input.pairingToken ?? '';
  const env = expoEnvPatch(
    input.expoEnv ?? null,
    token,
    input.options.port === undefined ? undefined : bridgeWsUrl(input.options.port),
  );
  if (env !== null) {
    return [
      {
        title: StepTitle.PAIRING_TOKEN,
        target: EXPO_ENV_PATH,
        status: StepStatus.APPLY,
        detail: `set ${EXPO_TOKEN_VAR} (EXPO_PUBLIC_* is what Expo inlines) — ${EXPO_ENV_PATH} is gitignored, so each teammate must run \`reticle init\` on their own machine`,
        write: { path: EXPO_ENV_PATH, content: env },
      },
      {
        title: StepTitle.PAIRING_TOKEN_PER_MACHINE,
        target: EXPO_ENV_PATH,
        status: StepStatus.NOTICE,
        detail: EXPO_TOKEN_PER_MACHINE_NOTICE,
      },
    ];
  }
  if ('' !== token) {
    return [];
  }
  // No daemon has run here yet, so there is no token to inline. Not a connect step, for the reason
  // CRA's is not: see `StepTitle.PAIRING_TOKEN` in connect-steps.ts.
  return [
    {
      title: StepTitle.PAIRING_TOKEN,
      target: EXPO_ENV_PATH,
      status: StepStatus.MANUAL,
      detail: `no pairing token yet — the daemon writes one on first run. Start it with \`reticle serve\` (or let your agent run \`reticle mcp\`), then \`reticle init\` again to write ${EXPO_TOKEN_VAR}`,
    },
  ];
}

/** The import half: into the root layout or `App` component, or a manual step naming the line. */
function expoImportStep(input: PlanInput): Step {
  const entry = input.expoEntry ?? null;
  if (null === entry) {
    return {
      title: StepTitle.CONNECT_SNIPPET_EXPO,
      target: EXPO_DEFAULT_ENTRY,
      status: StepStatus.MANUAL,
      detail: `Add \`${expoImportLine(EXPO_DEFAULT_ENTRY)}\` to your root layout (app/_layout.tsx), or \`${expoImportLine('App.tsx')}\` to App.tsx, after the existing imports.`,
    };
  }
  const patched = expoImportPatch(entry.source, expoImportLine(entry.path));
  if (null === patched) {
    return {
      title: StepTitle.CONNECT_SNIPPET_EXPO,
      target: entry.path,
      status: StepStatus.ALREADY,
      detail: 'already imported',
    };
  }
  return {
    title: StepTitle.CONNECT_SNIPPET_EXPO,
    target: entry.path,
    status: StepStatus.APPLY,
    detail: 'import the dev-only connect (Metro resolves it to the web module on web only)',
    write: { path: entry.path, content: patched },
    dependsOnInstall: true,
  };
}

export function expoSteps(input: PlanInput): Step[] {
  const { typescript } = input.detection;
  const webPath = expoWebModulePath(typescript);
  const nativePath = expoNativeModulePath(typescript);
  return [
    {
      title: StepTitle.CONNECT_MODULE,
      target: webPath,
      status: StepStatus.APPLY,
      detail: 'create the dev-only connect for web (Metro serves no index.html to inject into)',
      write: {
        path: webPath,
        content: expoWebModuleFile(input.options.port, input.options.projectId, {
          typescript,
          testids: input.testids ?? [],
        }),
      },
      dependsOnInstall: true,
    },
    {
      title: StepTitle.EXPO_NATIVE_MODULE,
      target: nativePath,
      status: StepStatus.APPLY,
      detail: 'create the empty module iOS and Android resolve instead, so they never load the SDK',
      write: { path: nativePath, content: expoNativeModuleFile(typescript) },
    },
    ...expoTokenSteps(input),
    expoImportStep(input),
  ];
}

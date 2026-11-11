/**
 * Wiring Reticle into the web build of an Expo app (#1707).
 *
 * Metro bundles Expo web, takes no plugin of ours, and serves no index.html we could reach, so the
 * connect arrives the way it does in CRA: a dev-only module imported from the app's own entry. Two
 * things differ from CRA.
 *
 * The entry is also the iOS and Android bundle, which must not load the browser SDK. Metro already
 * answers that with platform extensions: `./reticle-dev` resolves to `reticle-dev.web.ts` on web and
 * to `reticle-dev.ts` everywhere else, so the web file connects and the other one is empty.
 *
 * And the only environment variables Expo inlines into app code are `EXPO_PUBLIC_*`, so the token
 * travels as one, in `.env.local`, which the Expo template already gitignores (`.env*.local`).
 *
 * The modules sit at the project root rather than beside an expo-router layout: every file under
 * `app/` is a route to expo-router, so a connect module there would become a page.
 */

import { posix } from 'node:path';
import { bridgeWsUrl } from '@reticlehq/core';
import { CLI } from '@/project/agent-rules.js';
import { envTokenPatch } from './cra.js';
import { registerCapabilitiesCall } from './snippets.js';

export const EXPO_ENV_PATH = '.env.local';
export const EXPO_TOKEN_VAR = 'EXPO_PUBLIC_RETICLE_TOKEN';
/** The bridge URL, beside the token, for the reason `URL_VAR` is in cra.ts: Metro has no hook of ours. */
export const EXPO_URL_VAR = 'EXPO_PUBLIC_RETICLE_URL';

/** The import specifier both modules answer to. Metro adds the platform extension. */
const MODULE_BASE = 'reticle-dev';

/** The module Metro picks for web: the dev-only connect. */
export function expoWebModulePath(typescript: boolean): string {
  return `${MODULE_BASE}.web.${typescript ? 'ts' : 'js'}`;
}

/** The module Metro picks for iOS and Android: empty, so the native bundles never load the SDK. */
export function expoNativeModulePath(typescript: boolean): string {
  return `${MODULE_BASE}.${typescript ? 'ts' : 'js'}`;
}

/**
 * Where the import goes: the expo-router root layout, else the classic `App` component. The layout
 * comes first because an expo-router app renders through it and never mounts an `App.tsx`.
 */
export const EXPO_ENTRY_CANDIDATES = [
  'app/_layout.tsx',
  'app/_layout.jsx',
  'app/_layout.ts',
  'app/_layout.js',
  'src/app/_layout.tsx',
  'src/app/_layout.jsx',
  'src/app/_layout.ts',
  'src/app/_layout.js',
  'App.tsx',
  'App.jsx',
  'App.ts',
  'App.js',
];

/** The side-effect import of the root module, relative to the entry that carries it. */
export function expoImportLine(entryPath: string): string {
  const relative = posix.relative(posix.dirname(entryPath), MODULE_BASE);
  return `import '${relative.startsWith('.') ? relative : `./${relative}`}';`;
}

/**
 * A line that ends an import statement: `… from 'x'`, or a bare `import 'x'`.
 *
 * Needed because the import goes after the LAST import, and an expo-router layout often spreads one
 * over several lines (`import {\n  DarkTheme,\n  …\n} from '@react-navigation/native';`). Inserting
 * after the line that merely starts it would land inside the braces.
 */
const IMPORT_END = /(\bfrom\s*['"][^'"]+['"]|^\s*import\s*['"][^'"]+['"])\s*;?\s*$/;
const IMPORT_START = /^\s*import[\s{*'"]/;

/** Add the import after the last complete import statement, or null when it is already there. */
export function expoImportPatch(source: string, importLine: string): string | null {
  if (source.includes(importLine)) {
    return null;
  }
  const lines = source.split('\n');
  let insertAt = 0;
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (open) {
      if (IMPORT_END.test(line)) {
        open = false;
        insertAt = index + 1;
      }
      continue;
    }
    if (!IMPORT_START.test(line)) {
      continue;
    }
    if (IMPORT_END.test(line)) {
      insertAt = index + 1;
    } else {
      open = true;
    }
  }
  lines.splice(insertAt, 0, importLine);
  return lines.join('\n');
}

/** Set the token and url variables in `.env.local`, or null when nothing needs to change. */
export function expoEnvPatch(existing: string | null, token: string, url?: string): string | null {
  return envTokenPatch(existing, EXPO_TOKEN_VAR, token, EXPO_URL_VAR, url);
}

/** What the app says when the token is missing: the one symptom otherwise is a generic auth failure. */
export const EXPO_TOKEN_MISSING_NOTE =
  `${EXPO_TOKEN_VAR} is not set, so Reticle cannot pair with the daemon. ` +
  `The pairing token is per-machine and ${EXPO_ENV_PATH} is gitignored by the Expo template, ` +
  `so it does not survive a clone. Run \`${CLI} init\` in this project to write it for this machine.`;

/** Said beside the token write, for the reason `CRA_TOKEN_PER_MACHINE_NOTICE` is. */
export const EXPO_TOKEN_PER_MACHINE_NOTICE =
  `${EXPO_ENV_PATH} is in the Expo template's .gitignore, so the token just written does not travel. ` +
  'It works on THIS machine and nowhere else: a teammate cloning the repo, CI, or a container ' +
  'gets an app that boots, never pairs, and reports it only in the browser console. ' +
  `Each developer runs \`${CLI} init\` once locally, and restarts \`expo start\` so Metro inlines it.`;

interface ExpoModuleOptions {
  typescript: boolean;
  /** `data-testid` values scanned from the app's source, declared so the app is verifiable. */
  testids?: readonly string[];
}

/** The dev-only connect module Metro resolves for web. */
export function expoWebModuleFile(
  port: number | undefined,
  projectId: string | undefined,
  options: ExpoModuleOptions,
): string {
  const fields: string[] = [];
  if (port !== undefined) {
    fields.push(`url: '${bridgeWsUrl(port)}'`);
  }
  if (projectId !== undefined && projectId.length > 0) {
    fields.push(`projectId: '${projectId}'`);
  }
  const connectFields = [
    ...fields.map((f) => `      ${f},`),
    '      ...(url.length > 0 ? { url } : {}),',
    '      ...(token.length > 0 ? { token } : {}),',
  ].join('\n');
  const trailer = options.typescript ? '\nexport {};\n' : '\n';
  // `process.env.EXPO_PUBLIC_*` is read with dot access on purpose: Expo inlines only that exact
  // shape, and a computed key reads as undefined in the bundle.
  return `// Dev-only: connect Reticle on web. Metro resolves \`./${MODULE_BASE}\` to this file
// for web builds only; iOS and Android get the empty ${MODULE_BASE} module beside it.
//
// The pairing token arrives through ${EXPO_TOKEN_VAR} because
// EXPO_PUBLIC_* is the only thing Expo inlines into app code.
//
// \`typeof window\`: expo-router also renders web pages in Node, and the
// connect belongs to the browser, not to the dev server's process.
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  void import('@reticlehq/react').then((sdk) => {
    const { reticle, install, registerCapabilities } = sdk;
    install();
    const token = process.env.${EXPO_TOKEN_VAR} ?? '';
    // Written by \`${CLI} init\` from the daemon that was live when it ran. If the
    // daemon moves, re-run \`${CLI} init\` rather than editing the url below.
    const url = process.env.${EXPO_URL_VAR} ?? '';
    if (token.length === 0) {
      console.error(${JSON.stringify(`[reticle] ${EXPO_TOKEN_MISSING_NOTE}`)});
    }
    // Still attempt it: a bridge running without a token pairs fine.
    reticle.connect({
${connectFields}
    });
    // What the agent can drive without guessing.
${registerCapabilitiesCall(options.testids ?? [], '    ')}
  });
}
${trailer}`;
}

/** The module Metro resolves for iOS and Android: nothing, so the native bundles never load the SDK. */
export function expoNativeModuleFile(typescript: boolean): string {
  return `// Reticle connects on web only. Metro resolves \`./${MODULE_BASE}\` to this empty
// module for iOS and Android, and to ${MODULE_BASE}.web for web.
${typescript ? 'export {};\n' : ''}`;
}

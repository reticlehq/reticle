/**
 * Pure, conservative patchers for an Astro app: the config gets the token/root `define` and the
 * raised build target, one layout gets the dev-only connect `<script>`.
 *
 * Astro was the last gated framework where `init` printed a correct recipe and applied none of it —
 * the only ⚠ left on a supported stack, and the user's first session was two hand-copied snippets
 * away. Astro is Vite-based but renders its own HTML, so the Vite plugin's injection never fires and
 * there is no entry module to wire: the connect has to live in a page or layout `<script>`, and the
 * token has to be inlined by the config because nothing else is in the page's path to inject it.
 *
 * Both patchers bail to `manual` (the printed recipe) on any shape they do not fully recognise.
 * Half-editing a build config is worse than a documented manual step.
 */

import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import { UiLibrary } from './detect.js';
import { registerCapabilitiesCall, sdkImport } from './snippets.js';
import { patchViteOwningConfig, type ViteOwningConfig } from './vite-owning-config.js';

/** Present in a patched layout and in the printed recipe's script. */
const LAYOUT_MARKER = 'reticle.connect';
const BODY_CLOSE = '</body>';

/**
 * Astro's half of the Vite-owning config patch: the call to extend, and the SDK to pre-bundle.
 *
 * `@reticlehq/react` and not the detected UI library: Astro hosts islands from any framework, but
 * `frameworkPackages` gives every Astro app the React kit (see FRAMEWORK_ADAPTERS), so that is the
 * package the connect script imports and the one Vite must pre-bundle.
 */
const ASTRO_VITE_CONFIG: ViteOwningConfig = {
  defineCall: /defineConfig\s*\(\s*\{/,
  sdkSpecifier: sdkImport(UiLibrary.REACT).specifier,
};

export function patchAstroConfig(source: string): SourcePatch {
  return patchViteOwningConfig(source, ASTRO_VITE_CONFIG);
}

/** The dev-only connect that goes inside the layout's `<body>`. */
function astroConnectScript(
  port: number | undefined,
  projectId: string | undefined,
  uiLibrary: UiLibrary,
  testids: readonly string[],
): string {
  // Must match what `frameworkPackages` installed. Astro hosts islands from any framework, so an
  // Astro app whose islands are Vue or Svelte gets the sensor, and a script importing the React
  // adapter would load a package that is not in node_modules. See sdkImport.
  const sdk = sdkImport(uiLibrary);
  const url =
    port !== undefined && port !== RETICLE_DEFAULT_PORT
      ? `\n          url: '${bridgeWsUrl(port)}',`
      : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n          projectId: '${projectId}',` : '';
  return `    <script>
      if (import.meta.env.DEV) {
        const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
        const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
        const { reticle${sdk.usesInstall ? ', install' : ''}, registerCapabilities } = await import('${sdk.specifier}');
        ${sdk.usesInstall ? 'install();' : '// The sensor has no install(); that is the React adapter.'}
        reticle.connect({${id}${url}
          ...(token.length > 0 ? { token } : {}),
          ...(root.length > 0 ? { root } : {}),
        });
${registerCapabilitiesCall(testids, '        ')}
      }
    </script>
`;
}

export function patchAstroLayout(
  source: string,
  port: number | undefined,
  projectId: string | undefined,
  uiLibrary: UiLibrary = UiLibrary.REACT,
  testids: readonly string[] = [],
): SourcePatch {
  if (source.includes(LAYOUT_MARKER)) return { kind: PatchKind.ALREADY };
  const at = source.lastIndexOf(BODY_CLOSE);
  if (at < 0) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a `</body>` to place the connect script before",
    };
  }
  return {
    kind: PatchKind.APPLY,
    code: `${source.slice(0, at)}${astroConnectScript(port, projectId, uiLibrary, testids)}${source.slice(at)}`,
  };
}

/** Where Astro keeps ambient types — `create-astro` ships this file. */
export const ASTRO_ENV_DTS_PATH = 'src/env.d.ts';

/**
 * The declarations `astro check` needs for the Vite `define` names (#677).
 *
 * Matching SvelteKit's `hooks.client.ts` typing: `string | undefined`, because the define can be
 * absent when the pairing token file is missing.
 */
export const ASTRO_ENV_DTS_DECLARES =
  'declare const __RETICLE_TOKEN__: string | undefined;\n' +
  'declare const __RETICLE_ROOT__: string | undefined;\n';

/** Present once either declare is in the file — both are written together. */
const ENV_DTS_MARKER = '__RETICLE_TOKEN__';

/**
 * Append the Vite-define ambient declarations to `src/env.d.ts`, or create the file.
 *
 * Without this, `create-astro`'s default `"astro check && astro build"` fails with four
 * `ts(2304) Cannot find name '__RETICLE_TOKEN__'` errors after a clean init (#677).
 */
export function patchAstroEnvDts(existing: string | null): SourcePatch {
  if (null !== existing && existing.includes(ENV_DTS_MARKER)) {
    return { kind: PatchKind.ALREADY };
  }
  if (null === existing || '' === existing.trim()) {
    return { kind: PatchKind.APPLY, code: ASTRO_ENV_DTS_DECLARES };
  }
  const base = existing.endsWith('\n') ? existing : `${existing}\n`;
  return { kind: PatchKind.APPLY, code: `${base}${ASTRO_ENV_DTS_DECLARES}` };
}

/**
 * Pure, conservative patchers for an Astro app: the config gets the raised build target and the
 * watcher ignore, one layout gets the pairing token via frontmatter `<meta>` tags and a processed
 * `<script>` that statically imports a local connect module.
 *
 * Astro was the last gated framework where `init` printed a correct recipe and applied none of it —
 * the only ⚠ left on a supported stack, and the user's first session was two hand-copied snippets
 * away. Astro is Vite-based but renders its own HTML, so the Vite plugin's injection never fires and
 * there is no entry module to wire: the connect has to live in a page or layout.
 *
 * The token used to be inlined by `vite.define`. On Astro 7.2+ that substitution no longer reaches
 * the client pipeline (#1008), so the identifier stays literal, `connect()` omits `token`, and the
 * bridge refuses with "no pairing token on the page". The channel that does work is a `<meta>`: read
 * the file in frontmatter and let a local module query `meta[name="reticle-pairing-token"]`. Reading
 * per request also means a token written after the dev server started needs no restart. The SDK import
 * lives in `src/components/ReticleDev.ts` so the page only ever statically imports a project module.
 *
 * Both patchers bail to `manual` (the printed recipe) on any shape they do not fully recognise.
 * Half-editing a build config is worse than a documented manual step.
 */

import { posix } from 'node:path';
import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import { UiLibrary } from '@/detect/detect.js';
import { registerCapabilitiesCall, sdkImport } from './snippets.js';
import { patchViteOwningConfig, type ViteOwningConfig } from './vite-owning-config.js';

/**
 * Local module `init` writes for Astro. A processed page `<script>` statically imports this file
 * so Vite owns the SDK the same way it owns any other project module.
 *
 * `.ts`, not `.tsx`: the install-gate scaffold is `create-astro --template minimal`, which has no
 * React integration. The example app uses the same static import in a processed page `<script>`.
 */
export const ASTRO_RETICLE_DEV_PATH = 'src/components/ReticleDev.ts';

/**
 * Dev-only Astro connect module. Static SDK import, token from frontmatter `<meta>` tags.
 */
export function astroReticleDevFile(
  port: number | undefined,
  projectId: string | undefined,
  uiLibrary: UiLibrary = UiLibrary.REACT,
  testids: readonly string[] = [],
): string {
  const sdk = sdkImport(uiLibrary);
  const extra =
    port !== undefined && port !== RETICLE_DEFAULT_PORT ? `\n    url: '${bridgeWsUrl(port)}',` : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n    projectId: '${projectId}',` : '';
  return `import { reticle${sdk.usesInstall ? ', install' : ''}, registerCapabilities } from '${sdk.specifier}';

/** Dev-only: connect Reticle. Imported from a processed page script so Vite owns the SDK graph. */
export default function connectReticle() {
  const token =
    document.querySelector('meta[name="reticle-pairing-token"]')?.getAttribute('content') ?? '';
  const root =
    document.querySelector('meta[name="reticle-pairing-root"]')?.getAttribute('content') ?? '';
  const url =
    document.querySelector('meta[name="reticle-pairing-url"]')?.getAttribute('content') ?? '';
  if (0 === token.length) {
    console.warn(${JSON.stringify(ASTRO_MISSING_TOKEN_WARNING)});
  }
  ${sdk.usesInstall ? 'install();' : '// The sensor has no install(); that is the React adapter.'}
  reticle.connect({${id}${extra}
    ...(0 < token.length ? { token } : {}),
    ...(0 < root.length ? { root } : {}),
    ...(0 < url.length ? { url } : {}),
  });
${registerCapabilitiesCall(testids, '  ')}
}
`;
}

/** Present in a patched layout (and in an already-wired one that still has the old script). */
const LAYOUT_MARKER = 'reticle.connect';
const LAYOUT_MODULE_MARKER = 'connectReticle';
const BODY_CLOSE = '</body>';
const FRONTMATTER_FENCE = '---';

/**
 * Written into the Astro `vite:` block so a second init reports ALREADY. The Nuxt path uses
 * `__RETICLE_TOKEN__` in `define` as its marker; Astro no longer writes that name into the config.
 */
export const ASTRO_VITE_OWNING_MARKER = 'reticle-vite-owning';

/**
 * The one runtime condition that guarantees a refused connect, said out loud on the page.
 *
 * Matching the Vite plugin's missing-token wording, because Astro never loads that plugin. The
 * token is read at render time now, not at config load, so a reload is enough — the user does not
 * have to restart the dev server.
 */
export const ASTRO_MISSING_TOKEN_WARNING =
  '[reticle] no pairing token was available when this page rendered, so the app will connect ' +
  'and be refused — you will see NO SESSION even though the SDK loads and the socket opens. ' +
  'The token is written by the Reticle daemon: start it (`reticle serve`, or let your agent start ' +
  'it) and reload this page.';

/**
 * Astro's half of the Vite-owning config patch: the call to extend, and the SDK to pre-bundle.
 *
 * `@reticlehq/react` and not the detected UI library: Astro hosts islands from any framework, but
 * `frameworkPackages` gives every Astro app the React kit (see FRAMEWORK_ADAPTERS), so that is the
 * package the connect script imports and the one Vite must pre-bundle.
 *
 * `defineToken: false` is the #1008 fix. `build.target`, `optimizeDeps.include` and the `.reticle/`
 * watcher ignore stay — each has a measured reason and none of them is the defect.
 */
const ASTRO_VITE_CONFIG: ViteOwningConfig = {
  defineCall: /defineConfig\s*\(\s*\{/,
  sdkSpecifier: sdkImport(UiLibrary.REACT).specifier,
  defineToken: false,
  alreadyMarker: ASTRO_VITE_OWNING_MARKER,
};

export function patchAstroConfig(source: string): SourcePatch {
  return patchViteOwningConfig(source, ASTRO_VITE_CONFIG);
}

/**
 * Aliased imports so a layout that already pulled `readFileSync` from `node:fs` does not get a
 * duplicate binding. The names are the already-marker for the frontmatter half.
 */
const FRONTMATTER_ADDITIONS = `import { readFileSync as reticleReadFileSync } from 'node:fs';
import { homedir as reticleHomedir } from 'node:os';
import { join as reticleJoin } from 'node:path';
const pairingToken = (() => {
  if (!import.meta.env.DEV) return '';
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || reticleJoin(reticleHomedir(), '.reticle');
  try { return reticleReadFileSync(reticleJoin(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
})();
const pairingRoot = import.meta.env.DEV ? process.cwd() : '';
`;

/**
 * Import path from a layout/page to the generated connect module, always relative and posix.
 *
 * `src/layouts/Layout.astro` and `src/pages/index.astro` both resolve to `../components/ReticleDev`.
 */
export function astroReticleDevImport(layoutPath: string): string {
  const fromDir = posix.dirname(layoutPath.replaceAll('\\', '/'));
  const to = ASTRO_RETICLE_DEV_PATH.replace(/\.ts$/, '');
  let rel = posix.relative(fromDir, to);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** Meta tags plus a processed script that statically imports the local connect module. */
function astroConnectMarkup(moduleSpecifier: string): string {
  return `    <meta name="reticle-pairing-token" content={pairingToken} />
    <meta name="reticle-pairing-root" content={pairingRoot} />
    <script>
      import connectReticle from '${moduleSpecifier}';
      if (import.meta.env.DEV) {
        connectReticle();
      }
    </script>
`;
}

/**
 * Marker for the frontmatter half. It must be a name ONLY the frontmatter writes: this ran against
 * `pairingToken`, which the meta markup inserted one step earlier already contains, so the guard
 * always tripped and the token read was never added — leaving every scaffolded page throwing
 * `ReferenceError: pairingToken is not defined`.
 */
const FRONTMATTER_MARKER = 'reticleReadFileSync';

function withFrontmatter(source: string): string | null {
  if (source.includes(FRONTMATTER_MARKER)) return source;
  if (source.startsWith(FRONTMATTER_FENCE)) {
    const closeAt = source.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    if (closeAt < 0) return null;
    const inner = source.slice(FRONTMATTER_FENCE.length + 1, closeAt);
    const padded = inner.endsWith('\n') ? inner : `${inner}\n`;
    return `${FRONTMATTER_FENCE}\n${padded}${FRONTMATTER_ADDITIONS}${source.slice(closeAt + 1)}`;
  }
  return `${FRONTMATTER_FENCE}\n${FRONTMATTER_ADDITIONS}${FRONTMATTER_FENCE}\n${source}`;
}

export function patchAstroLayout(
  source: string,
  layoutPath: string = 'src/layouts/Layout.astro',
): SourcePatch {
  if (source.includes(LAYOUT_MARKER) || source.includes(LAYOUT_MODULE_MARKER)) {
    return { kind: PatchKind.ALREADY };
  }
  const at = source.lastIndexOf(BODY_CLOSE);
  if (at < 0) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a `</body>` to place the connect script before",
    };
  }
  const withScripts = `${source.slice(0, at)}${astroConnectMarkup(astroReticleDevImport(layoutPath))}${source.slice(at)}`;
  const withFence = withFrontmatter(withScripts);
  if (null === withFence) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a closing frontmatter fence to place the pairing-token read in",
    };
  }
  return { kind: PatchKind.APPLY, code: withFence };
}

/** Where Astro keeps ambient types — `create-astro` ships this file. */
export const ASTRO_ENV_DTS_PATH = 'src/env.d.ts';

/**
 * The declarations `astro check` needs for the window names the inline script writes (#677, #1008).
 */
export const ASTRO_ENV_DTS_DECLARES =
  'interface Window {\n' +
  '  __RETICLE_TOKEN__?: string;\n' +
  '  __RETICLE_ROOT__?: string;\n' +
  '}\n';

/** Present once either name is in the file — both are written together. */
const ENV_DTS_MARKER = '__RETICLE_TOKEN__';

/**
 * Append the window ambient declarations to `src/env.d.ts`, or create the file.
 *
 * Without this, `create-astro`'s default `"astro check && astro build"` fails with
 * `ts(2339) Property '__RETICLE_TOKEN__' does not exist on type 'Window'` after a clean init.
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

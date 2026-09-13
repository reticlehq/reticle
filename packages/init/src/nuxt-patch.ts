/**
 * Wiring Reticle into a Nuxt app: the config gets the token `define`, the plugin gets written.
 *
 * Nuxt owns its own Vite instance and renders its own HTML, so there is no `vite.config` to patch
 * and no `index.html` to inject into — the same position Astro is in, and it takes the same config
 * patch (see `vite-owning-config.ts`). The half Nuxt does differently is the connect itself: Nuxt's
 * own idiom is a `.client` plugin it auto-registers, not a `<script>` in a layout.
 *
 * The config patch is not optional and not cosmetic. The bridge requires a pairing token even on
 * localhost, nothing in a browser can read the file it lives in, and Nuxt loads no plugin of ours
 * that could inject it — so a plugin written beside an unpatched config is an app that dials the
 * daemon and is refused, with one line in a console nobody had open. That is why the two halves are
 * planned atomically.
 */

import type { SourcePatch } from './patch-kind.js';
import { patchViteOwningConfig, type ViteOwningConfig } from './vite-owning-config.js';
import { sdkImport } from './snippets.js';
import { UiLibrary } from './detect.js';

/** The config filenames Nuxt itself accepts, in the order `init` should prefer them. */
export const NUXT_CONFIG_CANDIDATES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];

/**
 * Nuxt's half of the Vite-owning config patch.
 *
 * The framework-neutral sensor, never the React kit: Nuxt renders Vue, and `FRAMEWORK_ADAPTERS`
 * installs `@reticlehq/browser` for it — so that is what the plugin imports and what Vite must
 * pre-bundle. Declaring the React kit here would warm a dep cache for a package that is not there.
 */
const NUXT_VITE_CONFIG: ViteOwningConfig = {
  defineCall: /defineNuxtConfig\s*\(\s*\{/,
  sdkSpecifier: sdkImport(UiLibrary.VUE).specifier,
};

export function patchNuxtConfig(source: string): SourcePatch {
  return patchViteOwningConfig(source, NUXT_VITE_CONFIG);
}

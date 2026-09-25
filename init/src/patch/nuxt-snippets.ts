/**
 * The Nuxt connect plugin `reticle init` writes, split out of snippets.ts (which crossed the
 * 1000-line cap): its path, the plugin file itself, the notice, and the manual fallback.
 */
import { ReticleDir } from '@reticlehq/core';
import { connectArg, registerCapabilitiesCall } from './snippets.js';

/** Where a Nuxt dev-only client plugin belongs. `.client` keeps it out of SSR; Nuxt auto-registers it. */
const NUXT_PLUGIN_PATH = 'app/plugins/reticle.client.ts';

/**
 * The plugin directory Nuxt actually scans, which is not the same on 3 and 4.
 *
 * Nuxt 4's default `srcDir` is `app/`, so plugins live in `app/plugins/`. Nuxt 3's is the project
 * root, so they live in `plugins/`. Writing to the wrong one is the silent failure this whole change
 * exists to remove: the file is on disk, `init` reports it green, Nuxt never scans that directory,
 * and no plugin is ever registered. Keyed on whether the app HAS an `app/` directory, which is the
 * same signal Nuxt itself uses to pick its srcDir.
 */
export function nuxtPluginPath(hasAppDir: boolean): string {
  return hasAppDir ? NUXT_PLUGIN_PATH : 'plugins/reticle.client.ts';
}

/**
 * The dev-only Nuxt client plugin `init` writes.
 *
 * Every trap in it is one somebody actually hit. `import.meta.dev` rather than a hostname check: the
 * reported failure was a snippet guarded on `window.location.hostname === 'localhost'`, which is
 * false on any hosts-file alias or LAN address and throws during SSR, so the connect never ran with
 * no error and no log line. `.client.ts` rather than an SSR guard, because that suffix is what keeps
 * this out of the server bundle. `@reticlehq/browser` rather than the React kit, because installing
 * a package named `@reticlehq/react` into a Vue codebase is the single thing most likely to make
 * somebody abandon the setup.
 *
 * The token is inlined by `nuxt.config`'s `vite.define` (see nuxt-patch.ts). The bridge requires it
 * even on localhost, and nothing in a browser can read the file it lives in.
 */
export function nuxtPluginFile(
  port: number | undefined,
  projectId?: string,
  testids: readonly string[] = [],
): string {
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  return `// Dev-only: connect Reticle from a Nuxt client plugin. Nuxt owns its own Vite instance and
// renders its own HTML, so the Vite plugin's index.html injection never fires — a .client plugin is
// the path that can register a session at all.
export default defineNuxtPlugin(() => {
  // import.meta.dev is resolved at BUILD time, so it does not care what hostname you develop on.
  // Do NOT guard on window.location.hostname === 'localhost': that is false on any hosts-file alias
  // or LAN address, and window does not exist during SSR.
  if (!import.meta.dev) return;
  void import('@reticlehq/browser').then(({ reticle, registerCapabilities }) => {
    // Both inlined by nuxt.config's vite.define, which \`reticle init\` wrote. The bridge refuses a
    // connect with no token even on localhost; the root makes source paths repo-relative.
    const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
    const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
    reticle.connect({
      ${fields}...(token.length > 0 ? { token } : {}),
      ...(root.length > 0 ? { root } : {}),
    });

    // What the agent can drive without guessing. Add a store here too — registerStore('cart',
    // piniaStore(useCartStore())) — and the agent can check what the app BELIEVES, not just what it
    // rendered. See node_modules/@reticlehq/server/docs/usage.md.
${registerCapabilitiesCall(testids, '    ')}
  });
});

declare const __RETICLE_TOKEN__: string | undefined;
declare const __RETICLE_ROOT__: string | undefined;
`;
}

/**
 * Said as its own NOTICE beside the write, not inside it: a running dev server does not pick up a
 * new plugin, and off localhost the connect needs two more arguments.
 *
 * A ✓ line is one SKILL.md tells the reader to skip, so a caveat carried on the ✓ is a caveat nobody
 * reads — and both of these end with an app that boots, looks correct and never pairs.
 */
export const NUXT_PLUGIN_NOTICE =
  'Restart the dev server: one that is already running does not pick up a new plugin — it will not ' +
  'appear in .nuxt/plugins/client.mjs and the app comes up with no SDK at all. And if your dev host ' +
  'is anything other than localhost (a hosts-file alias, a LAN IP, a tunnel), that connect call ' +
  'needs TWO additions, not one: allowNonLocalhost: true AND the token from ~/.reticle/pairing-token. ' +
  'The flag alone is NOT sufficient off localhost.';

/**
 * The Nuxt recipe, written out in full because each trap in it is one a Nuxt 4 app actually hit:
 * a Vue codebase classified as `html` and handed `@reticlehq/react`, a connect guarded on
 * `window.location.hostname === 'localhost'` (false on any hosts-file alias, and `window` does not
 * exist during SSR), and a running dev server that never picked up the new plugin.
 *
 * So: `import.meta.dev` instead of a hostname check, `.client.ts` instead of an SSR guard, the
 * framework-neutral sensor instead of the React kit, the non-localhost flag named up front, and the
 * restart said out loud.
 */
export function nuxtManual(port: number | undefined, projectId?: string): string {
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : base.slice(1, -1).trim();
  const connect = '' === fields ? 'reticle.connect()' : `reticle.connect({ ${fields} })`;
  return `Nuxt owns its own Vite instance and renders its own HTML, so there is no vite.config to patch
and no index.html to inject into. Wire it with a dev-only CLIENT plugin, which is Nuxt's own idiom:

1. Create ${NUXT_PLUGIN_PATH}:

     export default defineNuxtPlugin(() => {
       // import.meta.dev is the correct guard: it is resolved at build time, so it does not care
       // what hostname you develop on. Do NOT guard on window.location.hostname === 'localhost' —
       // that is false on any hosts-file alias or LAN address, and window does not exist in SSR.
       if (!import.meta.dev) return
       void import('@reticlehq/browser').then(({ reticle }) => {
         ${connect}
       })
     })

   The .client.ts suffix is load-bearing: it is what keeps this out of the server bundle.

2. Restart the dev server. A dev server that is already running does not pick up a new plugin —
   it will not appear in .nuxt/plugins/client.mjs, and the app will come up with no SDK at all.

3. If your dev host is anything other than localhost (a hosts-file alias, a LAN IP, a tunnel), that
   connect call needs TWO additions, not one: allowNonLocalhost: true AND a pairing token passed as
   token. The flag alone is NOT sufficient off localhost. The token is the one in
   ~/.reticle/pairing-token. Without both, the SDK loads and then refuses, and the only sign is one
   line in the browser console.

4. Add this to nuxt.config, so the dev server does not watch Reticle's own journal:

     vite: { server: { watch: { ignored: [/(^|[\\\\/])\\.${ReticleDir.ROOT.slice(1)}([\\\\/]|$)/] } } }

   Reticle journals every session into ${ReticleDir.ROOT}/ in your project root, rewriting one file
   in it continuously while a session is live. Nuxt's dev server watches that root, so without this
   it sees each write as a project file changing and full-reloads the page — which reconnects the
   SDK, which produces the next write. The loop runs several times a second and looks like anything
   except what it is: refs go stale, actions die mid-flight, and the session appears to flap.
   It is a RegExp rather than a glob on purpose — chokidar dropped glob support in v4, so a
   double-star pattern here is accepted and matches nothing.

The package is @reticlehq/browser — the framework-neutral sensor. DOM, network, console, routing and
source file:line all work in Vue. What you do not get is React component identity, which is the only
thing the React adapter adds. There is no Nuxt app in this project's CI, so this path is UNVERIFIED:
if something does not work, please open an issue.`;
}

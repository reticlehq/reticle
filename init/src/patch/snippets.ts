/**
 * Generated file contents and copy-paste snippets for `reticle init`. Kept as named constants/builders
 * so the runner never inlines free strings.
 */

import {
  RETICLE_DEFAULT_PORT,
  ReticleDir,
  bridgeWsUrl,
  RETICLE_CLIENT_HOST,
  RETICLE_WS_PATH,
} from '@reticlehq/core';
import { UiLibrary } from '../detect/detect.js';
import type { FoundStore } from '../detect/capabilities.js';
import { RETICLE_VERSION } from '../version.js';

/**
 * The SDK as one import a plain page can actually resolve.
 *
 * `init` used to tell static-HTML users that a page with no build step could not load the SDK, and
 * to go and stand up a bundler. That is true of a BARE specifier and false of a URL, and the
 * difference was the whole road for every server-rendered app we hear from: FastAPI, Flask, Django,
 * Streamlit, Rails. Proven end to end before this shipped, on a page served by `python3 -m
 * http.server`: a session connected, a snapshot returned, and two act_and_wait calls came back
 * `verified: "yes"`.
 *
 * jsDelivr rather than esm.sh, measured: a third of the requests and a third of the bytes for the
 * same result. `/+esm` is what makes it work, and the bare package URL does NOT: every file in
 * `dist` still carries bare workspace specifiers such as `@reticlehq/core`, so an unbundled entry
 * point dies on the first import. That is also why adding `unpkg`/`jsdelivr` fields to package.json
 * would not help.
 *
 * PINNED to this server's version on purpose. A floating import upgrades the page SDK underneath a
 * daemon that did not move, which is `version_skew` arriving by a route nothing checks.
 */
const CDN_SDK_URL = `https://cdn.jsdelivr.net/npm/@reticlehq/browser@${RETICLE_VERSION}/+esm`;

/**
 * The connect argument literal: a non-default port adds a `url`, and a projectId is always passed
 * (so the app is identifiable across port changes). Empty string only when neither applies.
 */
export function connectArg(port: number | undefined, projectId?: string): string {
  const parts: string[] = [];
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) {
    parts.push(`url: '${bridgeWsUrl(port)}'`);
  }
  if (projectId !== undefined && projectId.length > 0) parts.push(`projectId: '${projectId}'`);
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}

/**
 * The same literal, with the pairing token folded in.
 *
 * The token belongs INSIDE the call the user pastes. Every other stack has a build step to inline
 * it (the Vite plugin's `define`, Next's NEXT_PUBLIC_*, Astro's config, CRA's .env); the hand-wired
 * paths have none, so `init` inlines the literal it already read. Without it the bridge closes the
 * socket with AUTH_FAILED and no session ever appears: see Bridge's hello handler.
 *
 * An empty token is omitted rather than emitted as `token: ''`. A daemon that could not write to
 * $HOME runs without auth and trusts loopback, and an empty string would fail the comparison against
 * one that does hold a token.
 */
export function connectArgWithToken(
  port: number | undefined,
  projectId: string | undefined,
  pairingToken: string | undefined,
): string {
  const base = connectArg(port, projectId);
  if (pairingToken === undefined || 0 === pairingToken.length) return base;
  const inner = base.length > 0 ? base.slice(1, -1).trim() : '';
  return `{ ${[inner, `token: '${pairingToken}'`].filter((p) => p.length > 0).join(', ')} }`;
}

/**
 * Which SDK package the GENERATED code should import, and whether `install()` applies.
 *
 * This has to agree with `frameworkPackages`, and it did not. That function was changed so a Vue or
 * Svelte app installs `@reticlehq/browser` instead of the React adapter — correctly — while every
 * generated connect snippet still said `import('@reticlehq/react')`. A SvelteKit app would have
 * installed the sensor and then run a hook importing a package that is not there.
 *
 * `install()` is the React adapter's, not the sensor's: `@reticlehq/browser` exports `reticle` and no
 * `install`, so swapping the specifier alone would trade a missing module for a missing export.
 */
export function sdkImport(uiLibrary: UiLibrary): { specifier: string; usesInstall: boolean } {
  const react = uiLibrary !== UiLibrary.VUE && uiLibrary !== UiLibrary.SVELTE;
  return react
    ? { specifier: '@reticlehq/react', usesInstall: true }
    : { specifier: '@reticlehq/browser', usesInstall: false };
}

/**
 * The framework plugin to show ALONGSIDE reticle() in the example, so the ordering is clear.
 *
 * It used to be `react()` unconditionally, which is what a Vue app was shown — a plugin it does not
 * have, four lines after `init` had correctly detected Vue and said so. The example exists to show
 * that `reticle()` goes last, not to tell anyone which UI framework they are using.
 */
function frameworkPluginExample(uiLibrary: UiLibrary): string {
  switch (uiLibrary) {
    case UiLibrary.VUE:
      return 'vue()';
    case UiLibrary.SVELTE:
      return 'svelte()';
    case UiLibrary.REACT:
    case UiLibrary.PREACT:
      return 'react()';
    default:
      // Nothing detected: name no plugin rather than invent one. The reader keeps whatever they have.
      return '/* your existing plugins */';
  }
}

/** The Vite-config snippet printed when we can't safely auto-patch the config. */
export function viteManual(
  port: number | undefined,
  uiLibrary: UiLibrary = UiLibrary.UNKNOWN,
  inject = true,
  sourceMapping = true,
): string {
  const options = [
    ...(port === undefined ? [] : [`port: ${String(port)}`]),
    ...(false === inject ? ['inject: false'] : []),
    ...(sourceMapping ? [] : ['sourceMapping: false']),
  ];
  const call = 0 === options.length ? 'reticle()' : `reticle({ ${options.join(', ')} })`;
  const note = sourceMapping
    ? ''
    : `\n\n\`sourceMapping: false\` because this app renders through a non-DOM React renderer, where a
lowercase JSX tag is not an element. Stamping one crashes the app at commit time. You lose source
pointers, not the app.`;
  return `Add the Reticle plugin to your Vite config:

  import { reticle } from '@reticlehq/vite-plugin';

  export default defineConfig({
    plugins: [${frameworkPluginExample(uiLibrary)}, ${call}],
  });

Keep \`reticle()\` LAST so it sees the output of your other plugins. It only applies during \`vite\`
(dev) — it is dropped from \`vite build\`.${note}`;
}

/**
 * The electron-vite recipe: the plugin belongs in `renderer`, never in `main` or `preload`.
 *
 * `desktop: true` is load-bearing. Without it the plugin is serve-only, so a packaged renderer
 * (a production build with no dev server) ships with no connect() at all.
 */
export function electronViteManual(
  port: number | undefined,
  uiLibrary: UiLibrary = UiLibrary.UNKNOWN,
): string {
  const extras =
    port === undefined
      ? 'desktop: true, captureNetworkBodies: true'
      : `desktop: true, port: ${String(port)}, captureNetworkBodies: true`;
  return `Add the Reticle plugin to the \`renderer\` block of electron.vite.config, not \`main\`:

  import { reticle } from '@reticlehq/vite-plugin';

  export default defineConfig({
    main: { /* unchanged */ },
    preload: { /* unchanged */ },
    renderer: {
      plugins: [${frameworkPluginExample(uiLibrary)}, reticle({ ${extras} })],
    },
  });

\`desktop: true\` is required: a packaged renderer is a production build with no dev server, so the
default serve-only plugin is dropped from \`vite build\` and the shipped app never connects.

Also add \`import '@reticlehq/electron/preload'\` as the first line of your preload, and
\`installReticleCapture(win)\` in main after you construct the BrowserWindow.`;
}

/** Next.js config wrap — always printed (we never auto-rewrite next.config). */
export function nextConfigManual(configFile: string, sourceMapping = true): string {
  const options = sourceMapping ? '' : ', { sourceMapping: false }';
  const note = sourceMapping
    ? ''
    : `\n\n\`sourceMapping: false\` because this app renders through a non-DOM React renderer, where a
lowercase JSX tag is not an element. Stamping one crashes the app at commit time. You lose source
pointers, not the app.`;
  return `Wrap your ${configFile} export with withReticle (keeps SWC, dev-only):

  import { withReticle } from '@reticlehq/next';

  export default withReticle(nextConfig${options});${note}`;
}

/**
 * The dev-only client component that connects Reticle after hydration.
 *
 * The token is not optional. The bridge requires a pairing token even on localhost, and unlike Vite
 * (where the plugin injects it) a Next app has to carry it through `withReticle`, which publishes it
 * as `NEXT_PUBLIC_RETICLE_TOKEN`. This file used to connect with only a projectId, so every Next
 * setup ended at `bridge refused the connection: authentication failed` and no session ever appeared.
 */
export function nextReticleDevFile(
  port: number | undefined,
  projectId?: string,
  testids: readonly string[] = [],
  stores: readonly string[] = [],
  found: readonly FoundStore[] = [],
): string {
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  const ids = testids.map((t) => `'${t}'`).join(', ');
  // Same rule as the Vite module: a store we found is registered outright, and the commented hint
  // survives only for the libraries we can name but not wire.
  const storeImports = found.map((s) => `import { ${s.ident} } from '${s.importPath}';`).join('\n');
  // Eight spaces: nested inside useEffect → .then callback (see multiline shape below for #684).
  const storeBlock =
    found.length > 0
      ? found.map((s) => `        registerStore('${s.key}', ${s.ident});`).join('\n')
      : 0 === stores.length
        ? '        // No state library detected. If you add one, register it here — see node_modules/@reticlehq/server/docs/usage.md.'
        : stores.map((h) => `        // import your store, then: ${h}`).join('\n');
  const registerNames = found.length > 0 ? ', registerStore' : '';
  // Multiline connect + single blank after imports (#684): the one-line connect and the double blank
  // both fail Prettier on a clean Next install.
  return `'use client';
import { useEffect } from 'react';
${storeImports.length > 0 ? `${storeImports}\n` : ''}
/** Dev-only: connect Reticle + install the React adapter, after hydration. */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@reticlehq/react').then(
      ({ reticle, install, registerCapabilities${registerNames} }) => {
        install();
        // Both provided by withReticle() in next.config. The bridge rejects a connect with no token;
        // the root makes source paths repo-relative instead of absolute.
        const token = process.env.NEXT_PUBLIC_RETICLE_TOKEN;
        const root = process.env.NEXT_PUBLIC_RETICLE_ROOT;
        // withReticle() finds the daemon serving this project on every dev-server start. It wins over
        // any port written into this file at install time, so moving the daemon needs no edit here.
        const url = process.env.NEXT_PUBLIC_RETICLE_URL;
        reticle.connect({
          ${fields}...(url ? { url } : {}),
          ...(token ? { token } : {}),
          ...(root ? { root } : {}),
        });

        // ── Start with ONE flow. ────────────────────────────────────────────────────────────────
        // Registering a store is the highest-value line here: it lets the agent check what the app
        // BELIEVES, not just what it rendered. Pass the STORE, not \`() => store.getState()\` — the
        // store form wires \`subscribe\` too, so every mutation emits a diff; the getter form is
        // read-only.
${storeBlock}
        registerCapabilities({
          testids: [${ids}],${0 === testids.length ? ' // none found; add data-testid to your key elements' : ''}
          signals: [], // names you pass to reticle.signal()
          stores: [${found.map((s) => `'${s.key}'`).join(', ')}], // the keys you registered above
        });
      },
    );
  }, []);
  return null;
}
`;
}

/**
 * Astro connect instructions.
 *
 * Astro is Vite-based but SSRs its own HTML, so the plugin's index.html injection never fires, and
 * `vite` is not a direct dependency — so this used to fall through to the generic HTML advice, which
 * tells you to add a connect to an "entry module" Astro does not have, or to bundle the SDK with
 * esbuild. Both are wrong for Astro, and following either gets you nothing.
 *
 * Astro bundles a page `<script>`, so the bare import resolves there. The token has to be inlined by
 * the config because there is no plugin in the page's path to inject it, and `build.target` has to be
 * raised or Astro down-levels the modern SDK bundle and dies on a destructuring transform.
 */
/**
 * Name the file the connect <script> should go in — the layout when one exists, otherwise the page,
 * because a project with no layout has nowhere else to put it and should not be told otherwise.
 */
function layoutHost(layoutPath: string | undefined): string {
  return layoutPath === undefined
    ? '2. This project has no layout, so put it in the page you want instrumented (e.g.\n   src/pages/index.astro) — every page you want a session from needs it — inside <body>:'
    : `2. In ${layoutPath} (or any other page you want instrumented), inside <body>:`;
}

export function astroManual(
  port: number | undefined,
  projectId?: string,
  /**
   * A layout file that actually exists, when one does.
   *
   * Reported from the field: on `examples/framework-react` — which has no layout at all, only
   * `src/pages/index.astro` — init printed thirty lines telling the user to paste into "your
   * layout". Instructions that name a file the project does not have read as a mistake by the
   * reader, and cost them the time it takes to go and confirm it is missing.
   */
  layoutPath?: string,
): string {
  const extra =
    port !== undefined && port !== RETICLE_DEFAULT_PORT
      ? `\n          url: '${bridgeWsUrl(port)}',`
      : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n          projectId: '${projectId}',` : '';
  // Astro owns its Vite instance, so it has a build-time channel of its own: the same `define` that
  // already inlines the token can inline the daemon URL, resolved every time the config is read —
  // that is, on every `astro dev`. The port above is written once at install time and goes stale the
  // moment the daemon moves; this does not.
  //
  // Needs the projectId to know WHICH daemon is ours. Without one there is nothing to match on, and
  // adopting a daemon serving another project would report its state as this app's, so the whole
  // block is omitted rather than made to guess.
  const canDiscover = projectId !== undefined && projectId.length > 0;
  // Interpolated from core rather than typed into the template: this is the same wire string
  // `bridgeWsUrl` builds, and a generator that spells it out by hand is exactly how the four call
  // sites that constant exists to unify drifted apart in the first place.
  const RETICLE_CLIENT_HOST_LITERAL = `ws://${RETICLE_CLIENT_HOST}:`;
  const urlHelper = canDiscover
    ? `
  // The live daemon serving THIS project, re-read on every \`astro dev\`. Same rule as the Vite and
  // Next plugins: skip dead daemons, match on projectId, lowest port wins, '' when none matches.
  function reticleUrl() {
    const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
    let best;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('daemon-') || !file.endsWith('.json')) continue;
        let entry;
        try { entry = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
        if (entry.projectId !== '${projectId}') continue;
        try { process.kill(entry.pid, 0); } catch { continue; }
        if (best === undefined || entry.port < best) best = entry.port;
      }
    } catch { return ''; }
    return best === undefined ? '' : '${RETICLE_CLIENT_HOST_LITERAL}' + best + '${RETICLE_WS_PATH}';
  }
`
    : '';
  const urlDefine = canDiscover ? `\n        __RETICLE_URL__: JSON.stringify(reticleUrl()),` : '';
  const urlRead = canDiscover
    ? `\n      const url = typeof __RETICLE_URL__ !== 'undefined' ? __RETICLE_URL__ : '';`
    : '';
  // After the baked port, so the discovered one wins: later key in an object literal.
  const urlSpread = canDiscover ? `\n          ...(url.length > 0 ? { url } : {}),` : '';
  return `Astro renders its own HTML, so the connect goes in a page <script> and the pairing token is inlined by the config.

1. In astro.config.mjs — inline the daemon's token and raise the build target:

  import { readFileSync, readdirSync } from 'node:fs';
  import { homedir } from 'node:os';
  import { join } from 'node:path';

  function reticleToken() {
    const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
    try { return readFileSync(join(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
  }
${urlHelper}
  export default defineConfig({
    vite: {
      // Astro's default target down-levels the modern SDK bundle and fails on a destructuring transform.
      build: { target: 'es2022' },
      optimizeDeps: { esbuildOptions: { target: 'es2022' } },
      define: {
        __RETICLE_TOKEN__: JSON.stringify(reticleToken()),${urlDefine}
        // Without this, source pointers come back as absolute paths from YOUR machine — useless in a
        // report. Every other framework gets it from its build plugin; Astro owns its Vite instance.
        __RETICLE_ROOT__: JSON.stringify(process.cwd()),
      },
    },
  });

${layoutHost(layoutPath)}

  <script>
    if (import.meta.env.DEV) {
      const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
      const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';${urlRead}
      const { reticle, install } = await import('@reticlehq/react');
      install();
      reticle.connect({${id}${extra}${urlSpread}
          ...(token.length > 0 ? { token } : {}),
          ...(root.length > 0 ? { root } : {}),
      });
    }
  </script>

3. In src/env.d.ts — declare the Vite define names so \`astro check\` can see them (create-astro's
   default build runs check first, and without this it fails with Cannot find name '__RETICLE_TOKEN__'):

  declare const __RETICLE_TOKEN__: string | undefined;
  declare const __RETICLE_ROOT__: string | undefined;

Start the daemon BEFORE \`astro dev\`, so the token file exists when the config is read. Until it does the token is empty and the page reloads once the daemon is up.`;
}

/**
 * The `registerCapabilities` call every generated connect carries.
 *
 * Only the Vite and Next generators emitted one, so an Astro, SvelteKit, Nuxt or CRA app connected
 * and then reported `hasCapabilities: false` — `init` printing, about its own work, "is instrumented
 * and connected — but NOT verified". The testids are the ones already scanned out of the app's
 * source; an empty list still declares the block, because the comment on it is how somebody learns
 * the file is theirs to extend.
 *
 * `indent` because the call lands at four different depths: top level in a Vite dev module, inside a
 * `.then` in the Nuxt plugin, inside a `<script>` in an Astro layout.
 */
export function registerCapabilitiesCall(testids: readonly string[], indent: string): string {
  const ids = testids.map((t) => `'${t}'`).join(', ');
  const none = 0 === testids.length ? ' // none found; add data-testid to your key elements' : '';
  return `${indent}registerCapabilities({
${indent}  testids: [${ids}],${none}
${indent}  signals: [], // names you pass to reticle.signal()
${indent}  stores: [], // register a store above, then name its key here
${indent}});`;
}

/**
 * The app-side dev module the Vite plugin imports by convention.
 *
 * `registerCapabilities` tells the agent what it can drive without guessing; `registerStore` is the
 * one that matters most and the one we cannot write for you — detecting that an app depends on
 * zustand is easy, knowing which module exports the store instance is not, and a wrong import here
 * breaks the module everything else hangs off. So the store lines are generated COMMENTED, naming
 * the libraries actually found in package.json, with the exact call to uncomment.
 */
export function viteDevModuleFile(
  testids: readonly string[],
  stores: readonly string[],
  found: readonly FoundStore[] = [],
  uiLibrary: UiLibrary = UiLibrary.REACT,
): string {
  // The specifier has to be the package `frameworkPackages` installed. This file is the Vite path —
  // the commonest install there is — and it was hardcoded to `@reticlehq/react` while a Vue or
  // Svelte app was being given `@reticlehq/browser`, so the generated file imported something that
  // was not there. Caught by running `init` against a pristine Vue app, not by any gate.
  //
  // The sensor exports `registerCapabilities` and `registerStore` (and the store adapters) just as
  // the React kit does; the only thing it lacks is `install()`, which this file never called.
  const sdk = sdkImport(uiLibrary);
  const ids = testids.map((t) => `'${t}'`).join(', ');
  // A store we FOUND is imported and registered outright — the whole point of the file. The hints
  // stay only for the libraries we can name but not wire (they need an argument we cannot infer).
  const storeImports = found.map((s) => `import { ${s.ident} } from '${s.importPath}';`).join('\n');
  const storeBlock =
    found.length > 0
      ? found.map((s) => `  registerStore('${s.key}', ${s.ident});`).join('\n')
      : 0 === stores.length
        ? '  // No state library detected. If you add one, register it here — see node_modules/@reticlehq/server/docs/usage.md.'
        : stores.map((h) => `  // import your store, then: ${h}`).join('\n');
  const registerImport =
    found.length > 0 ? 'registerCapabilities, registerStore' : 'registerCapabilities';
  return `// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { ${registerImport} } from '${sdk.specifier}';
${storeImports.length > 0 ? `${storeImports}\n` : ''}
if (import.meta.env.DEV) {
  // ── Start with ONE flow. ─────────────────────────────────────────────────────────────────────
  // You do not need to describe the whole app to get value, and trying to is the slow path. Register
  // the store your most important flow reads, and list the testids that flow touches. Add more later,
  // when a flow you actually replay needs them.
  //
  // Registering a store is the highest-value line in this file: it lets the agent check what the app
  // BELIEVES, not just what it rendered — the class of bug a screenshot cannot see. Pass the STORE,
  // not \`() => store.getState()\`: the store form wires \`subscribe\` too, so every mutation emits a
  // state diff; the getter form is read-only and silently produces empty diffs.
${storeBlock}

  registerCapabilities({
    testids: [${ids}],${0 === testids.length ? ' // none found; add data-testid to your key elements' : ''}
    signals: [], // names you pass to reticle.signal()
    stores: [${found.map((s) => `'${s.key}'`).join(', ')}], // the keys you registered above
  });
}
`;
}

/** Where that module goes. Matches @reticlehq/vite-plugin's convention list. */
export const VITE_DEV_MODULE_PATH = 'src/reticle-dev.ts';
/**
 * electron-vite's renderer Vite root is `src/renderer`, so the plugin looks for
 * `src/renderer/src/reticle-dev.ts` — not the package-root path a plain Vite app uses.
 */
export const ELECTRON_VITE_DEV_MODULE_PATH = 'src/renderer/src/reticle-dev.ts';

/** Default root-layout path, used when no layout was found on disk (reporting only). */
export const NEXT_LAYOUT_PATH = 'app/layout.tsx';

/** Mount instruction for the root layout. */
export const NEXT_LAYOUT_MANUAL = `Mount <ReticleDev /> in your root layout (app/layout.tsx), dev-only:

  import { ReticleDev } from './reticle-dev';
  // inside <body>:
  {process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}`;

/**
 * Manual connect guidance for projects without a Vite/Next plugin. Most such projects still use a
 * BUNDLER (CRA, webpack, Parcel, Vue/Svelte CLIs) — for those, the connect goes in the entry MODULE,
 * where a bare `@reticlehq/react` import resolves. A bare import in a plain index.html does NOT resolve in
 * the browser, so we never tell a bundled app to do that (the old advice silently failed for CRA).
 */
/**
 * The whole install, for a page with no build step, as one block a person can paste.
 *
 * Extracted so the `no package.json` exit can print the SAME snippet `htmlManual` offers. That exit
 * is the one every server-rendered app reaches (FastAPI, Flask, Django, Rails, Streamlit), it is
 * where `init` stops, and until now it stopped with an explanation instead of an answer. A message
 * that says "add the snippet below" and then prints no snippet is the same defect wearing the
 * opposite sign, so the two share a builder rather than a copy.
 */
export function staticPageSnippet(connectArgLiteral: string): string {
  return `      <script type="module">
        import { reticle } from '${CDN_SDK_URL}';
        reticle.connect(${connectArgLiteral});
      </script>`;
}

/**
 * Streamlit has no served HTML template, and `st.markdown` inserts script markup without executing
 * it. Streamlit 1.63 added an explicit JavaScript boundary to `st.html`; use a classic script there
 * so it can dynamically import the ESM SDK in the app document. A head marker makes reruns
 * idempotent and is removed after an import failure so the next rerun can retry.
 */
export function streamlitPageSnippet(connectArgLiteral: string): string {
  return `import streamlit as st

st.html(
    """
    <script>
      (() => {
        if (document.getElementById('reticle-streamlit-connect')) return;
        const marker = document.createElement('meta');
        marker.id = 'reticle-streamlit-connect';
        document.head.appendChild(marker);
        void import('${CDN_SDK_URL}')
          .then(({ reticle }) => reticle.connect(${connectArgLiteral}))
          .catch((error) => {
            marker.remove();
            throw error;
          });
      })();
    </script>
    """,
    unsafe_allow_javascript=True,
)`;
}

/**
 * DEBUG-only middleware that injects Reticle into every Django-rendered page.
 *
 * Django serves templates, so the generic script tag has no single home: an app has many templates
 * and a base template it may not have. Middleware has exactly one, runs for every page, and is the
 * idiomatic Django answer — a field reporter arrived at this same shape by hand after `init` printed
 * a script tag and exited 1, and had to write the middleware and `.reticle.json` themselves.
 *
 * Guarded on `settings.DEBUG` so it can never reach production, and on the response being HTML so it
 * does not corrupt a JSON API response or a file download. Injected before `</body>` rather than in
 * `<head>`, so the SDK sees a parsed document.
 */
export function djangoMiddlewareSnippet(connectArgLiteral: string): string {
  return `# reticle_dev.py — add to MIDDLEWARE while DEBUG is on:
#   MIDDLEWARE = [..., "reticle_dev.ReticleDevMiddleware"]
from django.conf import settings

_SNIPPET = """<script type="module">
  import { reticle } from '${CDN_SDK_URL}';
  reticle.connect(${connectArgLiteral});
</script>"""


class ReticleDevMiddleware:
    """Inject the Reticle SDK into HTML responses during development only."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not settings.DEBUG:
            return response
        if "text/html" not in response.get("Content-Type", ""):
            return response
        # Streaming responses have no .content to rewrite; leave them alone.
        if getattr(response, "streaming", False):
            return response
        body = response.content.decode(response.charset)
        if "</body>" not in body:
            return response
        response.content = body.replace("</body>", _SNIPPET + "</body>", 1).encode(
            response.charset
        )
        if response.has_header("Content-Length"):
            response["Content-Length"] = str(len(response.content))
        return response
`;
}

export function htmlManual(
  port: number | undefined,
  projectId?: string,
  pairingToken?: string,
): string {
  const withToken = connectArgWithToken(port, projectId, pairingToken);
  const tokenNote =
    pairingToken === undefined || 0 === pairingToken.length
      ? ''
      : `\n\n  The \`token\` is this machine's pairing token, read from ~/.reticle/pairing-token. Keep it: the
  bridge REJECTS a connect without it ("authentication failed") and no session appears. It is
  per-machine and local-only, so do not commit it — a teammate's daemon mints their own.`;
  return `No Vite/Next plugin detected — wire the dev-only connect by hand. Pick the form for your setup:

  • Bundled app (Create React App, webpack, Parcel, Vue/Svelte CLI, etc.) — add to your ENTRY module
    (e.g. src/index.js or src/main.js), where '@reticlehq/react' resolves through your bundler:

      if (process.env.NODE_ENV !== 'production') {
        void import('@reticlehq/react').then(({ reticle, install }) => {
          install();
          reticle.connect(${withToken});
        });
      }${tokenNote}

  • Plain HTML with NO build step (FastAPI, Flask, Django, Rails, Streamlit, a hand-written page) —
    paste this into the page, in a template you only serve in development. There is nothing to
    install: no npm, no bundler, no package.json.

${staticPageSnippet(withToken)}

  Serving the app on something other than localhost (a hosts-file alias, a LAN IP, a container, a
  tunnel)? You need TWO things, not one: \`allowNonLocalhost: true\` AND a pairing token, passed as
  \`token\` on the same connect. The flag alone is NOT sufficient — off localhost the SDK refuses
  without a token as well, and that refusal is page-side, so the daemon sees only silence and every
  \`reticle doctor\` check still passes. The token is the one in \`~/.reticle/pairing-token\` (the
  build plugins read the same file). Without both, the SDK says so in the browser console only, so
  from here it looks exactly like nothing happened.`;
}

export const NEXT_RETICLE_DEV_PATH = 'app/reticle-dev.tsx';
export const SVELTEKIT_HOOKS_PATH = 'src/hooks.client.ts';

/**
 * Said to the user's face rather than discovered later. React, Next, Remix and Astro each have an
 * app and a CI gate; SvelteKit has neither, so "it generated some wiring" is not evidence it works.
 */
/**
 * Said out loud when the app does not render through React. The SDK is framework-agnostic — DOM,
 * network, console and routing all still work — but `@reticlehq/react` is a React adapter, so
 * component names and source mapping do not, and no CI gate covers this stack. Reporting all-green
 * here is the one thing this project exists not to do.
 */
export function unverifiedUiLibraryNote(library: string): string {
  // Preact is not in the same position as Vue or Svelte and must not be told it is. The React
  // adapter reaches Preact through `preact/compat`, which is what `docs/frameworks.mdx` has always
  // said, so telling a Preact reader they get no component identity contradicts our own docs and
  // talks them out of a package that is the right one for them. It is still ungated, which is the
  // honest caveat, and #129 is the issue for closing that.
  const identity =
    'preact' === library
      ? 'React component identity — component names and stacks — comes from `@reticlehq/react`, which reaches Preact through `preact/compat`. That path is not covered by a CI gate here, so treat it as expected-to-work rather than proven.'
      : 'What `@reticlehq/react` adds and you will NOT get is React component identity: component names and component stacks.';
  return `Detected a ${library} app. Reticle's DOM, network, console and state tools work here. ${'vue' === library ? 'Source `file:line` does NOT come through: the build plugin stamps JSX and, separately, Svelte components, and a Vue single-file component is neither — measured, a Svelte counter reports `src/lib/Counter.svelte:5` and the same drive on Vue reports no source at all.' : 'Source `file:line` does too — the build plugin stamps it for this library (measured on preact and svelte).'} ${identity} ${'vue' === library ? 'The install gate scaffolds a Vue app from scratch on every change, so this SETUP is proven; no gate drives a Vue app to a verdict, so the drive is not.' : `No CI gate covers ${library}.`} Driven on every change: Vite + React, Next.js, Remix, Astro. If something doesn't work, please open an issue.`;
}

export const UNVERIFIED_FRAMEWORK_NOTE =
  'Reticle has no SvelteKit app and no CI gate for one, so this wiring is untested — it may work, but nothing proves it and nothing will tell us if it breaks. Supported and gated today: Vite + React, Next.js, Remix and Astro. If the hook does not register a session, please open an issue.';

export const UNVERIFIED_TANSTACK_START_NOTE =
  'Reticle has no TanStack Start app and no CI gate for one, so this wiring is untested — it may work, but nothing proves it and nothing will tell us if it breaks. Supported and gated today: Vite + React, Next.js, Remix and Astro. If the client effect does not register a session, please open an issue.';

/**
 * Printed when init detects react-three-fiber. Reticle's model is DOM + store + network; a WebGL
 * canvas is none of those. Without this line, init succeeds, sessions connect, and surrounding UI
 * verdicts pass while the canvas — often the product — stays a blank rectangle (#880).
 */
export const WEBGL_CANVAS_LIMIT_NOTE =
  'A WebGL / react-three-fiber subtree is not observable as a scene: reticle_query and ' +
  'reticle_snapshot see a single <canvas>, and Reticle cannot pick faces or drive the camera ' +
  'inside it. DOM, registered store state, and network around the canvas still work — verify ' +
  'consequences there (import counts, mesh stats, solver results), not geometry under the pointer.';

/**
 * Dev-only client hook that connects Reticle in a SvelteKit app. SvelteKit renders through app.html and
 * never triggers Vite's index.html injection (verified), so the standard plugin can't auto-connect —
 * a client hook is the reliable path. SvelteKit runs src/hooks.client.ts on the client at startup.
 */
export function svelteKitHooksFile(
  port: number | undefined,
  projectId?: string,
  uiLibrary: UiLibrary = UiLibrary.SVELTE,
  testids: readonly string[] = [],
): string {
  // SvelteKit is Svelte, so this defaults to the sensor rather than the React adapter — and the
  // import here MUST match what `frameworkPackages` installed, or the hook loads a package that is
  // not in node_modules. See sdkImport.
  const sdk = sdkImport(uiLibrary);
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  return `// Dev-only: connect Reticle on the client. SvelteKit renders via app.html, so the Vite-plugin
// index.html injection doesn't fire — connect from this client hook instead.
if (import.meta.env.DEV) {
  void import('${sdk.specifier}').then(({ reticle${sdk.usesInstall ? ', install' : ''}, registerCapabilities }) => {
    ${sdk.usesInstall ? 'install();' : '// No React adapter here: the sensor has no install() to call.'}
    // The bridge requires the pairing token even on localhost. Nothing in a browser can read the
    // file it lives in, so @reticlehq/vite-plugin inlines it here at build time. Without it the
    // console reads "bridge refused the connection: authentication failed" and no session appears.
    const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
    const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
    const sdkVersion = typeof __RETICLE_SDK_VERSION__ !== 'undefined' ? __RETICLE_SDK_VERSION__ : '';
    reticle.connect({
      ${fields}...(token.length > 0 ? { token } : {}),
      ...(root.length > 0 ? { root } : {}),
      ...(sdkVersion.length > 0 ? { sdkVersion } : {}),
    });
${registerCapabilitiesCall(testids, '    ')}
  });
}

declare const __RETICLE_TOKEN__: string | undefined;
declare const __RETICLE_ROOT__: string | undefined;
declare const __RETICLE_SDK_VERSION__: string | undefined;
`;
}

/** The react-scripts major below which webpack cannot parse what @reticlehq/browser ships. */
export const WEBPACK4_REACT_SCRIPTS_MAJOR = 5;

/**
 * What to do when the bundler cannot parse our SDK at all.
 *
 * `@reticlehq/browser` ships untranspiled optional chaining and logical assignment.
 * react-scripts 4 runs webpack 4, whose parser predates both, AND excludes `node_modules` from
 * Babel -- so the build dies inside our `dist/` with a syntax error pointing at a file the user did
 * not write, before any session can exist (#680).
 *
 * Nothing else in `init` can catch this. Every check we run passes: the package installs, the entry
 * import is written, the token is inlined. The app simply does not compile, and the error names
 * `@reticlehq/browser/dist/index.js` rather than anything about Reticle.
 *
 * Two ways out, in the order a reader should consider them, because the second is the one that does
 * not require editing a bundler config to run a dev-only tool.
 */
export function webpack4TranspileNote(reactScriptsMajor: number): string {
  return `react-scripts ${String(reactScriptsMajor)} runs webpack 4, whose parser predates optional
  chaining and logical assignment. @reticlehq/browser ships both untranspiled, and react-scripts
  excludes node_modules from Babel — so \`npm start\` fails with a syntax error inside
  @reticlehq/browser/dist/index.js and no session is ever possible. Nothing else in this report can
  see that: the install, the import and the token are all correct.

  Either upgrade to react-scripts 5 (webpack 5 parses both natively, and needs no change on your
  side), or transpile this one package. With react-app-rewired or craco, add it to Babel's include:

      // config-overrides.js (react-app-rewired)
      const path = require('path');
      module.exports = (config) => {
        const rule = config.module.rules.find((r) => Array.isArray(r.oneOf))
          .oneOf.find((r) => String(r.test).includes('js') && r.include);
        rule.include = [rule.include, path.resolve('node_modules/@reticlehq/browser')];
        return config;
      };

  Scope it to @reticlehq/browser and nothing else: widening Babel across node_modules costs every
  rebuild in the project, for a dev-only dependency.`;
}

/** React Router's client-entry override point, in framework mode. */
export const REACT_ROUTER_ENTRY_PATH = 'app/entry.client.tsx';

/** The dev-only module @reticlehq/vite-plugin serves: connect() with the token already in it. */
const RETICLE_CONNECT_MODULE = '/@reticle-connect';

/** The one line that puts Reticle in a React Router client entry. */
export const REACT_ROUTER_CONNECT_LINE = `if (import.meta.env.DEV) void import('/@reticle-connect');`;

/**
 * The client entry `init` writes when React Router framework mode has none.
 *
 * `app/entry.client.tsx` is an OVERRIDE: React Router supplies a default client entry, and the file
 * only exists once an app opts out of it. So the generated one has to HYDRATE as well as connect —
 * a file containing only our import would replace that default with one that never hydrates, an app
 * that connects to Reticle and renders nothing. This is React Router v7's own default entry with one
 * line added.
 *
 * The import is the module `@reticlehq/vite-plugin` serves. It already carries the port, the project
 * id and this machine's pairing token, and it imports the app's `src/reticle-dev` dev module — which
 * is where capabilities are registered. Nothing here needs filling in.
 */
export function reactRouterEntryFile(): string {
  return `import { HydratedRouter } from 'react-router/dom';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';

// Dev-only: React Router framework mode renders HTML through its own request handler, so the Vite
// plugin's index.html injection never fires and the connect script never reaches the page. The
// plugin is still doing the other half of the job — it stamps data-reticle-source, which is what
// puts file:line on every verdict.
${REACT_ROUTER_CONNECT_LINE}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
`;
}

/**
 * Add the connect line to an entry the app already owns — or null when it is already there.
 *
 * After the LAST import, for the reason the CRA patch does the same: the entry's own imports must
 * still be evaluated first, and this is a side-effect import.
 */
export function reactRouterEntryPatch(source: string): string | null {
  if (source.includes(RETICLE_CONNECT_MODULE)) return null;
  const lines = source.split('\n');
  let lastImport = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*import\s/.test(line)) lastImport = index;
  }
  lines.splice(lastImport + 1, 0, REACT_ROUTER_CONNECT_LINE);
  return lines.join('\n');
}

/** Where a Nuxt dev-only client plugin belongs. `.client` keeps it out of SSR; Nuxt auto-registers it. */
export const NUXT_PLUGIN_PATH = 'app/plugins/reticle.client.ts';

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
 * The Nuxt recipe, written out in full because every trap in it is one somebody actually hit.
 *
 * Reported from the field, in the order they were hit: `init` classified a Nuxt 4 app as `html`, so
 * it installed a package named `@reticlehq/react` (with `react` in its peer dependencies) into a Vue
 * codebase — the reporter only continued after auditing our dist to confirm there are no React
 * imports at runtime, which most people will not do. It then handed over a snippet guarded on
 * `window.location.hostname === 'localhost'`, which fails twice over in Nuxt: `window` does not
 * exist during SSR, and the dev host here was a hosts-file alias (required for the backend's
 * white-label origin detection), so the guard was false and the connect never ran — no error, no log
 * line, nothing to debug. And nothing said a running dev server does not pick up a new plugin.
 *
 * So: `import.meta.dev` (build-time, host-independent) instead of a hostname check, `.client.ts`
 * instead of an SSR guard, the framework-neutral sensor instead of the React kit, the non-localhost
 * flag named up front, and the restart said out loud.
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

/**
 * Root-level project config for Reticle. Written by `reticle init`; read by `reticle mcp` for the port
 * and by tooling for the stable projectId (the app's identity across port changes).
 */
export function reticleConfigContent(
  framework: string,
  port: number | undefined,
  projectId?: string,
  installSource?: string,
): string {
  const fields: Record<string, unknown> = { framework };
  if (projectId !== undefined && projectId.length > 0) fields['projectId'] = projectId;
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) fields['port'] = port;
  // How this install arrived, recorded HERE because it is a property of the install and the only
  // moment anything knows it is the moment it happens. It reaches us as an environment variable set
  // by whichever channel ran the install, and an environment variable is gone by the next command,
  // so every event after this one reported `unknown` and the question "which channel actually
  // converts" could not be asked at all. Written once, read for the life of the project.
  //
  // A closed vocabulary, narrowed before it gets here, so this can never carry a path or a URL.
  if (installSource !== undefined && installSource.length > 0) {
    fields['installSource'] = installSource;
  }
  return `${JSON.stringify(fields, null, 2)}\n`;
}

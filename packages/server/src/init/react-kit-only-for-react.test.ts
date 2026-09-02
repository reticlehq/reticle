/**
 * A Vue or Svelte codebase must not be told to install `@reticlehq/react`.
 *
 * The reasoning was already written down in this file, for Nuxt:
 *
 *   "The framework-neutral sensor, NOT the React kit. Nuxt renders Vue, and installing a package
 *    named @reticlehq/react — with `react` in its peer dependencies — into a Vue codebase is the
 *    single thing most likely to make someone abandon the setup, whether or not it works."
 *
 * It was applied to the one framework whose NAME implies Vue, and not to the case where the same
 * thing is true and the name does not say so. A Vue app on plain Vite is `Framework.VITE`, and a
 * SvelteKit app is Svelte, and both were handed the React kit.
 *
 * Found by running `reticle init --dry-run` against a real Electron + Vue + Pinia app (MarkText, the
 * `electron-vue-pinia` fixture from #121, which nobody had ever run the installer against). The
 * output detected Vue correctly, said in as many words that React component identity is what you
 * will NOT get — and then, four lines later, told the reader to install `@reticlehq/react`.
 *
 * The UI library is detected before any of this runs, so the information was there the whole time.
 */

import { describe, expect, it } from 'vitest';
import { frameworkPackages } from './plan.js';
import { Framework, UiLibrary } from './detect.js';

const REACT_KIT = '@reticlehq/react';
const SENSOR = '@reticlehq/browser';

describe('the React kit is only installed into a React codebase', () => {
  it('gives a Vue app on Vite the framework-neutral sensor', () => {
    const packages = frameworkPackages(Framework.VITE, UiLibrary.VUE);
    expect(
      packages,
      'a Vue codebase must not be handed a package named @reticlehq/react',
    ).not.toContain(REACT_KIT);
    expect(packages).toContain(SENSOR);
  });

  it('gives a Svelte app on SvelteKit the sensor too', () => {
    const packages = frameworkPackages(Framework.SVELTEKIT, UiLibrary.SVELTE);
    expect(packages).not.toContain(REACT_KIT);
    expect(packages).toContain(SENSOR);
  });

  it('still gives a React app on Vite the React kit', () => {
    // The direction that must not regress: React identity is the thing the kit is FOR, and the
    // whole find→fix loop is weaker without component names.
    expect(frameworkPackages(Framework.VITE, UiLibrary.REACT)).toContain(REACT_KIT);
  });

  it('still gives Next the React kit, since Next is React by construction', () => {
    expect(frameworkPackages(Framework.NEXT, UiLibrary.REACT)).toContain(REACT_KIT);
  });

  it('treats Preact as React, because the adapter works through preact/compat', () => {
    // Documented behaviour elsewhere in the repo: Preact gets component identity via the React
    // adapter. Sending it the bare sensor would be a downgrade, not a fix.
    expect(frameworkPackages(Framework.VITE, UiLibrary.PREACT)).toContain(REACT_KIT);
  });

  it('keeps the React kit when the UI library cannot be determined', () => {
    // Unknown is not evidence of Vue. The kit is harmless in a React-ish app and the build plugin
    // needs a peer; guessing "sensor" on no evidence would silently drop component identity from
    // apps that should have it.
    expect(frameworkPackages(Framework.VITE, UiLibrary.UNKNOWN)).toContain(REACT_KIT);
  });

  it('still gives Nuxt the sensor, which is where this rule was already right', () => {
    expect(frameworkPackages(Framework.NUXT, UiLibrary.VUE)).not.toContain(REACT_KIT);
  });

  it('gives a Vue electron-vite app the sensor plus the Electron helper', () => {
    const packages = frameworkPackages(Framework.ELECTRON_VITE, UiLibrary.VUE);
    expect(packages).not.toContain(REACT_KIT);
    expect(packages).toContain(SENSOR);
    expect(packages).toContain('@reticlehq/electron');
  });
});

/**
 * The unverified-library note must not contradict our own docs about Preact.
 *
 * `docs/frameworks.mdx` has always said Preact gets the React adapter through `preact/compat`, and
 * `frameworkPackages` installs it for exactly that reason. The note told a Preact reader the
 * opposite — that React component identity is what they will NOT get — which both contradicts the
 * docs and talks them out of the package that is right for them.
 *
 * Vue and Svelte genuinely do not get it, and must keep being told so plainly.
 */
describe('the unverified note tells each library the truth about component identity', () => {
  it('does not tell a Preact app it loses component identity', async () => {
    const { unverifiedUiLibraryNote } = await import('./snippets.js');
    const note = unverifiedUiLibraryNote('preact');
    expect(note).not.toContain('will NOT get');
    expect(note).toContain('preact/compat');
    // Still honest about the gap that remains: it works by design, not by proof.
    expect(note.toLowerCase()).toContain('not covered by a ci gate');
  });

  it('still tells a Vue app plainly that it does not get component identity', async () => {
    const { unverifiedUiLibraryNote } = await import('./snippets.js');
    expect(unverifiedUiLibraryNote('vue')).toContain('will NOT get');
  });
});

/**
 * What init INSTALLS and what init GENERATES must name the same package.
 *
 * This is the half I got wrong first time. Changing `frameworkPackages` so a Vue or Svelte app gets
 * `@reticlehq/browser` was right, and every generated connect snippet still said
 * `import('@reticlehq/react')` — so a SvelteKit install would have written a client hook importing a
 * package that is not in `node_modules`. The dry-run plan looked correct and the install was broken.
 *
 * `install()` is the second half of the same trap: it is the React adapter's, and `@reticlehq/browser`
 * exports `reticle` with no `install`. Swapping only the specifier would trade a missing module for a
 * missing export.
 *
 * Caught by reading a real fixture's generated hook rather than by any gate.
 */
describe('the generated import matches the installed package', () => {
  const cases: [string, Framework, UiLibrary][] = [
    ['SvelteKit + Svelte', Framework.SVELTEKIT, UiLibrary.SVELTE],
    ['Vite + Vue', Framework.VITE, UiLibrary.VUE],
    ['Vite + React', Framework.VITE, UiLibrary.REACT],
    ['Vite + Preact', Framework.VITE, UiLibrary.PREACT],
  ];

  it.each(cases)('%s imports a package it also installs', async (_label, framework, ui) => {
    const { sdkImport } = await import('./snippets.js');
    expect(frameworkPackages(framework, ui)).toContain(sdkImport(ui).specifier);
  });

  it('the sensor path does not call install(), which it does not export', async () => {
    const { sdkImport, svelteKitHooksFile } = await import('./snippets.js');
    expect(sdkImport(UiLibrary.SVELTE).usesInstall).toBe(false);
    const hook = svelteKitHooksFile(undefined, 'demo', UiLibrary.SVELTE);
    expect(hook).toContain("import('@reticlehq/browser')");
    expect(hook).not.toContain('install();');
  });

  it('the React path still calls install(), which is what adds component identity', async () => {
    const { sdkImport, svelteKitHooksFile } = await import('./snippets.js');
    expect(sdkImport(UiLibrary.REACT).usesInstall).toBe(true);
    expect(svelteKitHooksFile(undefined, 'demo', UiLibrary.REACT)).toContain('install();');
  });
});

/**
 * The note must not promise a Vue app a source pointer it will not get.
 *
 * It said source `file:line` works "regardless of UI library (measured on preact and svelte)". The
 * parenthetical was doing a lot of work: the plugin stamps JSX and, separately, Svelte components,
 * and a Vue single-file component is neither. Measured on pristine scaffolds the same day — a Svelte
 * counter reports `src/lib/Counter.svelte:5`, and the identical drive on Vue reports no `source` at
 * all — so the sentence promised a Vue reader the one signal they do not get.
 */
describe('the note tells the truth about source pointers', () => {
  it('tells a Vue app it does NOT get file:line', async () => {
    const { unverifiedUiLibraryNote } = await import('./snippets.js');
    const note = unverifiedUiLibraryNote('vue');
    expect(note).toContain('does NOT come through');
    expect(note).toContain('single-file component');
  });

  it('still tells preact and svelte that it does', async () => {
    const { unverifiedUiLibraryNote } = await import('./snippets.js');
    for (const lib of ['preact', 'svelte']) {
      expect(unverifiedUiLibraryNote(lib), lib).toContain('does too');
    }
  });

  it('says Vue’s install is gated while its drive is not', async () => {
    // Understating is as wrong as overstating: the install gate scaffolds Vue from scratch now.
    const note = (await import('./snippets.js')).unverifiedUiLibraryNote('vue');
    expect(note).toContain('SETUP is proven');
    expect(note).not.toContain('No CI gate covers vue');
  });
});

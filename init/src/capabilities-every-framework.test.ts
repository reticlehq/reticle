/**
 * Every framework whose `init` WRITES a connect module must register capabilities in it.
 *
 * Measured against pristine scaffolds: only the Vite path (`viteDevModuleFile`) and the Next path
 * (`nextReticleDevFile`) generated a `registerCapabilities` call. Astro, SvelteKit, Nuxt and CRA got
 * a connect with none — so the app dialled the daemon and `init` then printed, about its own work,
 * "is instrumented and connected — but NOT verified". A connect that advertises nothing to drive is
 * an app an agent cannot act on without guessing.
 *
 * `hasCapabilities()` also counts LIVE testids (adapters/realm/dom/src/registry/capabilities.ts), so a
 * DECLARED list is not the only route to true — it is the only one `init` controls, and the one that
 * survives an app whose testids all arrive after a route change.
 */

import { describe, expect, it } from 'vitest';
import { Framework, PackageManager, UiLibrary, type Detection } from './detect/detect.js';
import { FRAMEWORK_ADAPTERS } from './plan/framework-adapter.js';
import { StepStatus, type PlanInput, type Step } from './plan/plan.js';

const PROBE_TESTID = 'checkout-submit';

const detection = (framework: Framework, uiLibrary: UiLibrary): Detection => ({
  framework,
  uiLibrary,
  typescript: true,
  packageManager: PackageManager.NPM,
  reactMajor: undefined,
  needsSourceMapping: true,
});

/** A minimal Astro config + layout, so the Astro path patches rather than printing its recipe. */
const ASTRO_CONFIG =
  "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n";
const ASTRO_LAYOUT = '<html>\n  <body>\n    <slot />\n  </body>\n</html>\n';

const planInput = (framework: Framework, uiLibrary: UiLibrary): PlanInput => ({
  detection: detection(framework, uiLibrary),
  claudeCli: false,
  mcpExists: false,
  viteConfig: { path: 'vite.config.ts', source: 'export default { plugins: [] };\n' },
  astroConfig: { path: 'astro.config.mjs', source: ASTRO_CONFIG },
  astroLayout: { path: 'src/layouts/Layout.astro', source: ASTRO_LAYOUT },
  nextConfigFile: 'next.config.mjs',
  nextConfigSource: 'export default {};\n',
  nextLayout: { path: 'app/layout.tsx', source: '<html><body>{children}</body></html>\n' },
  nextReticleDevExists: false,
  nuxtConfig: { path: 'nuxt.config.ts', source: 'export default defineNuxtConfig({});\n' },
  craEntry: { path: 'src/index.js', source: "import React from 'react';\n" },
  pairingToken: 'tok',
  testids: [PROBE_TESTID],
  options: { port: 4400, mcp: false, install: true, projectId: 'demo' },
});

/** Everything this framework's plan writes to disk. */
const writes = (steps: readonly Step[]): string[] =>
  steps
    .filter((s) => s.status === StepStatus.APPLY && s.write !== undefined)
    .map((s) => s.write?.content ?? '');

/**
 * HTML is the one framework with no file to write — there is no bundler, so the connect is a
 * hand-pasted snippet by construction. Listed rather than skipped by a filter, so adding a framework
 * makes someone decide which side it is on.
 */
const WRITES_A_CONNECT: readonly (readonly [Framework, UiLibrary])[] = [
  [Framework.NEXT, UiLibrary.REACT],
  [Framework.VITE, UiLibrary.REACT],
  [Framework.REACT_ROUTER, UiLibrary.REACT],
  [Framework.SVELTEKIT, UiLibrary.SVELTE],
  [Framework.ASTRO, UiLibrary.REACT],
  [Framework.CRA, UiLibrary.REACT],
  [Framework.NUXT, UiLibrary.VUE],
];

describe('a generated connect declares what the app can be driven by', () => {
  for (const [framework, uiLibrary] of WRITES_A_CONNECT) {
    it(`registers capabilities on ${framework}`, () => {
      const written = writes(FRAMEWORK_ADAPTERS[framework].steps(planInput(framework, uiLibrary)));
      expect(written.some((c) => c.includes('registerCapabilities('))).toBe(true);
    });

    it(`registers them in the file that actually connects, on ${framework}`, () => {
      // The one that makes this more than a spelling check. SvelteKit's plan WRITES the Vite dev
      // module — which is imported by the injected connect, and SvelteKit's connect comes from a
      // client hook instead, so that module is never loaded and its registration never runs. A file
      // that dials the daemon and registers nothing is the shape of the defect.
      const written = writes(FRAMEWORK_ADAPTERS[framework].steps(planInput(framework, uiLibrary)));
      for (const content of written.filter((c) => c.includes('reticle.connect('))) {
        expect(content).toContain('registerCapabilities(');
      }
    });

    it(`carries the scanned testids through on ${framework}`, () => {
      const written = writes(FRAMEWORK_ADAPTERS[framework].steps(planInput(framework, uiLibrary)));
      expect(written.some((c) => c.includes(PROBE_TESTID))).toBe(true);
    });
  }

  it('leaves plain HTML alone — it has no file to write', () => {
    const steps = FRAMEWORK_ADAPTERS[Framework.HTML].steps(
      planInput(Framework.HTML, UiLibrary.REACT),
    );
    expect(writes(steps)).toEqual([]);
  });
});

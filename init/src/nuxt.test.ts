/**
 * A Nuxt app must not be handed React and a guard that cannot fire.
 *
 * Before this, Nuxt fell through every branch to `html`: it has no `vite.config` to patch and serves
 * no `index.html` to inject into. The fall-through was not merely unhelpful, it was wrong in three
 * separate ways at once — it installed `@reticlehq/react` (peer-depending on React) into a Vue
 * codebase, it wrote `"framework": "html"` into .reticle.json, and the snippet it printed guarded on
 * `window.location.hostname === 'localhost'`, which throws during SSR and is false on any dev host
 * that is not literally localhost. The reported result was "a wired-looking install that can never
 * connect", with no console line to debug because the guard meant the connect never ran.
 */

import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { detect, Framework, UiLibrary } from './detect/detect.js';
import { frameworkPackages } from './plan/plan.js';
import { nuxtManual, nuxtPluginPath } from './patch/snippets.js';
import { nuxtSteps } from './plan/plan-framework.js';
import { StepStatus, type PlanInput } from './plan/plan.js';
import { patchNuxtConfig } from './patch/nuxt-patch.js';
import { PatchKind } from './patch/patch-kind.js';

const nuxtProject = {
  pkg: { devDependencies: { nuxt: '^4.4.8', vue: '^3.5.0' } },
  configFiles: new Set(['nuxt.config.ts']),
  lockfiles: new Set(['pnpm-lock.yaml']),
};

describe('detection', () => {
  it('recognises Nuxt in its own right', () => {
    const detected = detect(nuxtProject);
    expect(detected.framework).toBe(Framework.NUXT);
    expect(detected.uiLibrary).toBe(UiLibrary.VUE);
  });

  it('still recognises Nuxt when the app also carries a vite dependency', () => {
    const detected = detect({
      ...nuxtProject,
      pkg: { devDependencies: { nuxt: '^4.4.8', vue: '^3.5.0', vite: '^7.0.0' } },
      configFiles: new Set(['nuxt.config.ts', 'vite.config.ts']),
    });
    expect(detected.framework).toBe(Framework.NUXT);
  });

  it('does not mistake a plain Vue+Vite app for Nuxt', () => {
    const detected = detect({
      pkg: { devDependencies: { vue: '^3.5.0', vite: '^7.0.0' } },
      configFiles: new Set(['vite.config.ts']),
      lockfiles: new Set(),
    });
    expect(detected.framework).toBe(Framework.VITE);
  });
});

describe('packages', () => {
  it('installs the framework-neutral sensor, never the React kit', () => {
    const packages = frameworkPackages(Framework.NUXT);
    expect(packages).toContain('@reticlehq/browser');
    expect(packages).not.toContain('@reticlehq/react');
  });
});

describe('the plugin init writes', () => {
  const planInput = (over: Partial<PlanInput> = {}): PlanInput =>
    ({
      detection: detect(nuxtProject),
      claudeCli: false,
      mcpExists: false,
      options: { port: 4400, projectId: 'proj-1' },
      nuxtConfig: { path: 'nuxt.config.ts', source: 'export default defineNuxtConfig({});\n' },
      nuxtHasAppDir: true,
      nuxtPluginExists: false,
      testids: ['checkout-submit'],
      ...over,
    }) as unknown as PlanInput;

  const write = (over: Partial<PlanInput> = {}): string =>
    nuxtSteps(planInput(over)).find((s) => true === s.write?.path.endsWith('reticle.client.ts'))
      ?.write?.content ?? '';

  it('WRITES the plugin instead of printing a recipe nobody applies', () => {
    const step = nuxtSteps(planInput()).find(
      (s) => true === s.write?.path.endsWith('reticle.client.ts'),
    );
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.path).toBe('app/plugins/reticle.client.ts');
  });

  it('puts it where Nuxt 3 auto-registers it when there is no app/ directory', () => {
    expect(nuxtPluginPath(false)).toBe('plugins/reticle.client.ts');
    expect(nuxtPluginPath(true)).toBe('app/plugins/reticle.client.ts');
  });

  it('guards on import.meta.dev, never on the hostname', () => {
    const content = write();
    expect(content).toContain('if (!import.meta.dev) return;');
    // The hostname check appears once, as the thing NOT to do — never as the guard itself.
    expect(content).not.toMatch(/if \(window\.location\.hostname/);
  });

  it('carries the pairing token, which the bridge requires even on localhost', () => {
    expect(write()).toContain('__RETICLE_TOKEN__');
  });

  it('declares what the app can be driven by', () => {
    const content = write();
    expect(content).toContain('registerCapabilities(');
    expect(content).toContain('checkout-submit');
  });

  it('imports the framework-neutral sensor, never the React kit', () => {
    expect(write()).toContain("import('@reticlehq/browser')");
    expect(write()).not.toContain('@reticlehq/react');
  });

  it('leaves an existing plugin alone', () => {
    const step = nuxtSteps(planInput({ nuxtPluginExists: true })).find((s) =>
      s.title.includes('Nuxt'),
    );
    expect(step?.status).toBe(StepStatus.ALREADY);
  });

  it('still prints the recipe when the config cannot be patched', () => {
    // The token is inlined BY the config. A plugin written beside a config we could not patch is an
    // app that dials the bridge and is refused — so both halves go manual together, as Astro does.
    const steps = nuxtSteps(planInput({ nuxtConfig: null }));
    expect(steps.every((s) => s.status !== StepStatus.APPLY)).toBe(true);
    expect(steps.some((s) => s.status === StepStatus.MANUAL)).toBe(true);
  });
});

describe('the nuxt.config patch', () => {
  const CONFIG = 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n';

  it('inlines the token and the repo root, which nothing else in a Nuxt app can', () => {
    const patch = patchNuxtConfig(CONFIG);
    expect(patch.kind).toBe(PatchKind.APPLY);
    const code = patch.kind === PatchKind.APPLY ? patch.code : '';
    expect(code).toContain('__RETICLE_TOKEN__');
    expect(code).toContain('__RETICLE_ROOT__');
    expect(code).toContain('pairing-token');
  });

  it('keeps the journal out of the dev-server watcher', () => {
    const patch = patchNuxtConfig(CONFIG);
    const code = patch.kind === PatchKind.APPLY ? patch.code : '';
    const literal = /ignored:\s*\[\/(.+)\/\]/.exec(code);
    if (literal?.[1] === undefined) throw new Error('the patch emits no regex literal');
    expect(new RegExp(literal[1]).test('.reticle/ambient.json')).toBe(true);
  });

  it('is idempotent', () => {
    const once = patchNuxtConfig(CONFIG);
    const code = once.kind === PatchKind.APPLY ? once.code : '';
    expect(patchNuxtConfig(code).kind).toBe(PatchKind.ALREADY);
  });

  it('pre-bundles the sensor, so the dynamic import cannot lose its dep-cache URL', () => {
    const patch = patchNuxtConfig(CONFIG);
    const code = patch.kind === PatchKind.APPLY ? patch.code : '';
    expect(code).toContain("'@reticlehq/browser'");
  });
});

describe('the recipe', () => {
  const recipe = nuxtManual(4400, 'proj-1');

  it('guards on import.meta.dev, and warns against the hostname check rather than emitting it', () => {
    expect(recipe).toContain('if (!import.meta.dev) return');
    // The hostname check appears once, as the thing NOT to do — never as the guard itself.
    expect(recipe).toMatch(/Do NOT guard on window\.location\.hostname/);
    expect(recipe).not.toMatch(/if \(window\.location\.hostname === 'localhost'\)/);
  });

  it('puts the plugin where Nuxt will auto-register it, client-side only', () => {
    expect(nuxtPluginPath(true)).toBe('app/plugins/reticle.client.ts');
    expect(recipe).toContain(nuxtPluginPath(true));
  });

  it('says the dev server must be restarted', () => {
    expect(recipe).toMatch(/restart the dev server/i);
  });

  it('names the non-localhost flag, the trap with no error message', () => {
    expect(recipe).toContain('allowNonLocalhost');
  });

  it('carries the projectId through', () => {
    expect(recipe).toContain('proj-1');
  });

  it('does not claim verified support it does not have', () => {
    expect(recipe).toContain('UNVERIFIED');
  });
});

/**
 * Nuxt owns its own Vite instance and never loads the Vite plugin, so the plugin's watcher ignore
 * does not reach it — and the reload loop it prevents is not Nuxt-specific. The daemon journals
 * into `.reticle/` in the project root, Nuxt's dev server watches that root, and every journal write
 * comes back as a full page reload that reconnects the SDK and produces the next journal write.
 */
describe('the journal does not drive the dev server', () => {
  const recipe = nuxtManual(undefined);

  it('tells the app to keep the journal out of the watcher, with a matcher that works', () => {
    // The literal itself, not a description of it. A glob would read fine here and match nothing on
    // the chokidar Vite 7+ ships.
    const literal = /ignored:\s*\[\/(.+)\/\]/.exec(recipe);
    if (literal?.[1] === undefined) throw new Error('the recipe emits no regex literal');
    const matcher = new RegExp(literal[1]);
    expect(matcher.test(`${ReticleDir.ROOT}/ambient.json`)).toBe(true);
    expect(matcher.test('src/App.vue')).toBe(false);
  });

  it('says where that goes, so the step is followable', () => {
    expect(recipe).toContain('nuxt.config');
  });
});

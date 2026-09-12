/**
 * #773: TanStack Start SSRs `<html>` from `src/routes/__root.tsx` and never sends Vite's index.html.
 *
 * The Vite plugin's non-desktop injection is a `transformIndexHtml` hook, which Start never calls.
 * `init` classified the app as Vite, wired the plugin, reported every step green ("also injects
 * connect()"), and the page never got the connect script — confirmed in the field as many minutes of
 * "still verifying" against a daemon showing no session.
 *
 * Exactly the class SvelteKit, Astro and React Router framework mode are already detected for, and
 * detected in the same place: before the generic Vite branch.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, UiLibrary, type DetectInput } from '../detect/detect.js';
import { buildPlan, frameworkPackages, StepStatus, type PlanInput } from '../plan/plan.js';
import { tanstackStartSteps, VITE_PLUGIN_DETAIL, viteSteps } from '../plan/plan-framework.js';
import { TANSTACK_START_ROOT_PATH } from './tanstack-start.js';
import { isConnectStep } from '../plan/connect-steps.js';

const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
  ...over,
});

const START_PKG = {
  dependencies: { '@tanstack/react-start': '^1.0.0', react: '^19.0.0' },
  devDependencies: { vite: '^6.0.0' },
};

function basePlan(over: Partial<PlanInput> = {}): PlanInput {
  return {
    detection: detect(input({ pkg: START_PKG })),
    claudeCli: false,
    mcpExists: false,
    viteConfig: null,
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: 4400, mcp: false, install: false, projectId: 'demo' },
    ...over,
  };
}

describe('detecting TanStack Start', () => {
  it('keys on @tanstack/react-start', () => {
    const detection = detect(input({ pkg: START_PKG, configFiles: new Set(['vite.config.ts']) }));
    expect(detection.framework).toBe(Framework.TANSTACK_START);
  });

  it('keys on the older @tanstack/start package', () => {
    const detection = detect(
      input({
        pkg: {
          dependencies: { '@tanstack/start': '^1.0.0', react: '^19.0.0' },
          devDependencies: { vite: '^6.0.0' },
        },
        configFiles: new Set(['vite.config.ts']),
      }),
    );
    expect(detection.framework).toBe(Framework.TANSTACK_START);
  });

  it('wins over the generic Vite branch, which is the whole point', () => {
    // On `main` this app is Framework.VITE: the plugin is wired, every step is green ("also injects
    // connect()"), and nothing ever injects connect() into a document Start renders itself.
    const detection = detect(input({ pkg: START_PKG, configFiles: new Set(['vite.config.ts']) }));
    expect(detection.framework).not.toBe(Framework.VITE);
  });

  it('leaves TanStack Query on the Vite path', () => {
    // The store adapter already works. Treating Query as Start would replace a working injection
    // with a manual step on a plain Vite SPA.
    const detection = detect(
      input({
        pkg: {
          dependencies: { '@tanstack/react-query': '^5.0.0', react: '^19.0.0' },
          devDependencies: { vite: '^6.0.0' },
        },
        configFiles: new Set(['vite.config.ts']),
      }),
    );
    expect(detection.framework).toBe(Framework.VITE);
  });

  it('leaves TanStack Router library mode on the Vite path', () => {
    // `@tanstack/react-router` without Start still renders through index.html, which the plugin
    // does reach. Same judgement as react-router library mode.
    const detection = detect(
      input({
        pkg: {
          dependencies: { '@tanstack/react-router': '^1.0.0', react: '^19.0.0' },
          devDependencies: { vite: '^6.0.0' },
        },
        configFiles: new Set(['vite.config.ts']),
      }),
    );
    expect(detection.framework).toBe(Framework.VITE);
  });

  it('leaves Next alone, which also owns its own rendering', () => {
    const detection = detect(
      input({ pkg: { dependencies: { next: '^15.0.0', '@tanstack/react-start': '^1.0.0' } } }),
    );
    expect(detection.framework).toBe(Framework.NEXT);
  });
});

describe('what init installs for it', () => {
  it('is the React kit and the Vite plugin', () => {
    // Start IS a Vite app rendering React. Only the connect injection differs, and the plugin is
    // still what stamps data-reticle-source — without it every verdict loses file:line.
    expect(frameworkPackages(Framework.TANSTACK_START, UiLibrary.REACT)).toEqual([
      '@reticlehq/react',
      '@reticlehq/vite-plugin',
    ]);
  });
});

describe('the connect step it plans', () => {
  it('targets the document module, not index.html', () => {
    const connect = tanstackStartSteps(basePlan()).find((s) => isConnectStep(s.title));
    expect(connect?.target).toBe(TANSTACK_START_ROOT_PATH);
    expect(connect?.status).toBe(StepStatus.MANUAL);
  });

  it('names a discovered root when it is not the default path', () => {
    const connect = tanstackStartSteps(
      basePlan({ tanstackStartRoot: 'app/routes/__root.tsx' }),
    ).find((s) => isConnectStep(s.title));
    expect(connect?.target).toBe('app/routes/__root.tsx');
  });

  it('is a CONNECT step, so a warning on it fails init instead of reading as advice', () => {
    const connect = tanstackStartSteps(basePlan()).find((s) => isConnectStep(s.title));
    expect(connect).toBeDefined();
    expect(isConnectStep(connect?.title ?? '')).toBe(true);
  });

  it('says why the plugin alone cannot do it, and to keep the plugin anyway', () => {
    const detail = tanstackStartSteps(basePlan()).find((s) => isConnectStep(s.title))?.detail ?? '';
    expect(detail).toContain('__root.tsx');
    expect(detail).toContain('inject: false');
    expect(detail).toContain('data-reticle-source');
    expect(detail).toContain('useEffect');
    expect(detail).toContain("import('@reticlehq/react')");
    expect(detail).toContain('__RETICLE_TOKEN__');
    expect(detail).toContain('install()');
    expect(detail).toMatch(/[Rr]estart/);
    expect(detail).toContain('Do not guard on window.location.hostname');
    expect(detail).toContain('import.meta.env.DEV');
    expect(detail).not.toContain("from '@reticlehq/react'");
  });

  it('says Start is ungated rather than claiming the install is proven', () => {
    const notice = tanstackStartSteps(basePlan()).find((s) => StepStatus.NOTICE === s.status);
    expect(notice?.title).toMatch(/UNVERIFIED/);
    expect(notice?.detail ?? '').toMatch(/no CI gate/i);
  });
});

describe('the plugin step it plans', () => {
  const VITE_SRC = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`;

  const withConfig = (): PlanInput =>
    basePlan({
      viteConfig: { path: 'vite.config.ts', source: VITE_SRC },
      options: { port: undefined, mcp: false, install: false, projectId: 'demo' },
    });

  it('does not claim the plugin injects connect()', () => {
    expect(VITE_PLUGIN_DETAIL.TANSTACK_START).toContain('inject: false');
    expect(VITE_PLUGIN_DETAIL.TANSTACK_START).toContain('data-reticle-source');
    expect(VITE_PLUGIN_DETAIL.TANSTACK_START).not.toContain('also injects connect()');
  });

  it('writes reticle({ inject: false }) so stamps remain and injection is not promised', () => {
    const plugin = viteSteps(withConfig(), VITE_PLUGIN_DETAIL.TANSTACK_START, false).find(
      (s) => 'Vite plugin' === s.title,
    );
    expect(plugin?.status).toBe(StepStatus.APPLY);
    expect(plugin?.write?.content ?? '').toContain('inject: false');
    expect(plugin?.detail ?? '').not.toContain('also injects connect()');
  });

  it('still plans the plugin when buildPlan runs the Start branch', () => {
    const plan = buildPlan(withConfig());
    expect(plan.framework).toBe(Framework.TANSTACK_START);
    const plugin = plan.steps.find((s) => 'Vite plugin' === s.title);
    expect(plugin?.write?.content ?? '').toContain('inject: false');
    const connect = plan.steps.find((s) => 'Connect snippet (TanStack Start)' === s.title);
    expect(connect?.status).toBe(StepStatus.MANUAL);
    expect(isConnectStep(connect?.title ?? '')).toBe(true);
  });
});

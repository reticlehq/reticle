/**
 * Remix v2 is React Router framework mode under its old name, and `init` did not know that.
 *
 * Detection keyed framework mode on `@react-router/dev` or a `react-router.config.*` only, so a
 * Remix-on-Vite app (`@remix-run/dev`'s `vitePlugin`) fell through to plain Vite: the plugin was
 * wired, every step went green, and the page never connected — Remix SSRs its own HTML, so the
 * plugin's `index.html` injection never fires. Hand-adding the React Router connect line to
 * `app/entry.client.tsx` connected, so the fix is detection plus the steps that already work.
 *
 * The classic compiler (no Vite) has no plugin to serve that line at all, so it gets an honest ⚠
 * rather than a green plan it cannot keep.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, UiLibrary, type DetectInput } from './detect/detect.js';
import { buildPlan, frameworkPackages, StepStatus, type PlanInput } from './plan/plan.js';
import { isConnectStep, StepTitle } from './plan/connect-steps.js';
import { REACT_ROUTER_CONNECT_LINE, REACT_ROUTER_ENTRY_PATH } from './patch/snippets.js';

const REMIX_VITE_PKG = {
  dependencies: { '@remix-run/react': '^2.16.8', react: '^18.2.0', 'react-dom': '^18.2.0' },
  devDependencies: { '@remix-run/dev': '^2.16.8', vite: '^6.0.0' },
};
const REMIX_CLASSIC_PKG = {
  dependencies: { '@remix-run/react': '^2.16.8', react: '^18.2.0' },
  devDependencies: { '@remix-run/dev': '^2.16.8' },
};
const REMIX_VITE_CONFIG = `import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [remix(), tsconfigPaths()],
});
`;

const detectInput = (over: Partial<DetectInput>): DetectInput => ({
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
  ...over,
});

function planFor(
  pkg: DetectInput['pkg'],
  viteConfig: PlanInput['viteConfig'],
  entry: string | null = null,
): PlanInput {
  return {
    detection: detect(
      detectInput({
        pkg,
        configFiles: new Set(null === viteConfig ? ['remix.config.js'] : ['vite.config.ts']),
      }),
    ),
    claudeCli: false,
    mcpExists: false,
    viteConfig,
    nextConfigFile: null,
    nextReticleDevExists: false,
    reactRouterEntryExists: entry !== null,
    reactRouterEntrySource: entry,
    options: { port: 4400, mcp: false, install: true, projectId: 'demo' },
  };
}

describe('detecting Remix', () => {
  it('is not plain Vite, which is what it used to be classified as', () => {
    const detection = detect(
      detectInput({ pkg: REMIX_VITE_PKG, configFiles: new Set(['vite.config.ts']) }),
    );
    expect(detection.framework).toBe(Framework.REMIX);
  });

  it('keys the classic compiler on the same package, so it is not misread as a plain page', () => {
    const detection = detect(
      detectInput({ pkg: REMIX_CLASSIC_PKG, configFiles: new Set(['remix.config.js']) }),
    );
    expect(detection.framework).toBe(Framework.REMIX);
  });

  it('leaves React Router framework mode to its own branch', () => {
    const detection = detect(
      detectInput({ pkg: { devDependencies: { '@react-router/dev': '^7.0.0', vite: '^6' } } }),
    );
    expect(detection.framework).toBe(Framework.REACT_ROUTER);
  });

  it('installs the React kit and the Vite plugin, like React Router framework mode', () => {
    expect(frameworkPackages(Framework.REMIX, UiLibrary.REACT)).toEqual([
      '@reticlehq/react',
      '@reticlehq/vite-plugin',
    ]);
  });
});

describe('Remix on Vite', () => {
  const vite = { path: 'vite.config.ts', source: REMIX_VITE_CONFIG };

  it('writes the client entry, hydrating through RemixBrowser', () => {
    const step = buildPlan(planFor(REMIX_VITE_PKG, vite)).steps.find(
      (s) => s.target === REACT_ROUTER_ENTRY_PATH,
    );
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(isConnectStep(step?.title ?? '')).toBe(true);
    const content = step?.write?.content ?? '';
    expect(content).toContain(REACT_ROUTER_CONNECT_LINE);
    // The file is an OVERRIDE of Remix's default entry: without hydration the app renders nothing.
    expect(content).toContain('RemixBrowser');
    expect(content).toContain('@remix-run/react');
    expect(content).toContain('hydrateRoot');
    expect(content).not.toContain('react-router/dom');
  });

  it('adds one line to an entry the app already revealed', () => {
    const revealed = `import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

startTransition(() => {
  hydrateRoot(document, <StrictMode><RemixBrowser /></StrictMode>);
});
`;
    const step = buildPlan(planFor(REMIX_VITE_PKG, vite, revealed)).steps.find(
      (s) => s.target === REACT_ROUTER_ENTRY_PATH,
    );
    expect(step?.status).toBe(StepStatus.APPLY);
    const content = step?.write?.content ?? '';
    for (const line of revealed.trim().split('\n')) expect(content).toContain(line);
    expect(content).toContain(REACT_ROUTER_CONNECT_LINE);
  });

  it('wires the Vite plugin into vite.config, which serves the connect module the entry imports', () => {
    const step = buildPlan(planFor(REMIX_VITE_PKG, vite)).steps.find(
      (s) => s.title === StepTitle.VITE_PLUGIN,
    );
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.content).toContain('reticle(');
  });
});

describe('Remix on the classic compiler', () => {
  it('says plainly that it cannot be wired, and fails init rather than exiting green', () => {
    const plan = buildPlan(planFor(REMIX_CLASSIC_PKG, null));
    const step = plan.steps.find((s) => s.title === StepTitle.CONNECT_SNIPPET_REMIX);
    expect(step?.status).toBe(StepStatus.MANUAL);
    expect(isConnectStep(step?.title ?? '')).toBe(true);
    expect(step?.detail).toMatch(/classic/i);
    expect(step?.detail).toMatch(/vite/i);
    // Nothing written: a file that imports a module no plugin serves is worse than no file.
    expect(plan.steps.some((s) => s.write?.path === REACT_ROUTER_ENTRY_PATH)).toBe(false);
  });
});

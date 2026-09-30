/**
 * `src/reticle-dev.ts` has to actually load on every framework `init` writes it for.
 *
 * Reproduced on fresh SvelteKit and TanStack Start scaffolds: the module was written, and the only
 * thing that imports it is the Vite plugin's injected connect — which neither framework runs, because
 * each connects itself (SvelteKit from `src/hooks.client.ts`, Start from a client effect). Stores and
 * capabilities registered there silently never ran. And the plugin was written without
 * `inject: false` on SvelteKit, so it went on promising an injection that never fires.
 */
import { describe, expect, it } from 'vitest';
import { Framework, PackageManager, UiLibrary, type Detection } from '@/detect/detect.js';
import { FRAMEWORK_ADAPTERS } from './framework-adapter.js';
import { StepStatus, type PlanInput, type Step } from './plan-types.js';
import { StepTitle } from './connect-steps.js';

const VITE_SRC = `import { defineConfig } from 'vite';
export default defineConfig({ plugins: [] });
`;

const START_ROOT = `/// <reference types="vite/client" />
import type { ReactNode } from 'react';
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';

export const Route = createRootRoute({
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
`;

function detection(framework: Framework, uiLibrary: UiLibrary): Detection {
  return {
    framework,
    uiLibrary,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    packageManager: PackageManager.PNPM,
  };
}

function steps(framework: Framework, uiLibrary: UiLibrary, over: Partial<PlanInput> = {}): Step[] {
  return FRAMEWORK_ADAPTERS[framework].steps({
    detection: detection(framework, uiLibrary),
    claudeCli: false,
    mcpExists: true,
    viteConfig: { path: 'vite.config.ts', source: VITE_SRC },
    nextConfigFile: null,
    nextReticleDevExists: false,
    options: { port: undefined, mcp: false, install: false, projectId: 'demo' },
    ...over,
  });
}

const written = (all: readonly Step[], path: string): string =>
  all.find((s) => s.write?.path === path)?.write?.content ?? '';

describe('SvelteKit', () => {
  const plan = steps(Framework.SVELTEKIT, UiLibrary.SVELTE);

  it('imports the dev module from the hook that connects', () => {
    expect(written(plan, 'src/hooks.client.ts')).toContain("import('./reticle-dev')");
  });

  it('writes the plugin with inject: false, because the hook connects', () => {
    expect(written(plan, 'vite.config.ts')).toContain('inject: false');
  });
});

describe('React Router framework mode', () => {
  it('keeps the injection on: its entry imports the module the plugin serves', () => {
    // `/@reticle-connect` is served only while inject is on, and that module is what imports the
    // dev module here — so this framework is the one Vite-based app that must NOT say inject:false.
    const plan = steps(Framework.REACT_ROUTER, UiLibrary.REACT);
    expect(written(plan, 'vite.config.ts')).not.toContain('inject: false');
  });
});

describe('TanStack Start', () => {
  const root = 'src/routes/__root.tsx';
  const plan = steps(Framework.TANSTACK_START, UiLibrary.REACT, {
    tanstackStartRoot: root,
    tanstackStartRootSource: START_ROOT,
  });

  it('writes a client connect component that loads the dev module', () => {
    const component = written(plan, 'src/reticle-connect.tsx');
    expect(component).toContain('useEffect');
    expect(component).toContain("import('./reticle-dev')");
    expect(component).toContain('declare const __RETICLE_TOKEN__');
  });

  it('renders it in the document the root route actually has, instead of a manual step', () => {
    const patched = plan.find((s) => s.title === StepTitle.CONNECT_SNIPPET_TANSTACK_START);
    expect(patched?.status).toBe(StepStatus.APPLY);
    const source = patched?.write?.content ?? '';
    expect(source).toContain("import { ReticleConnect } from '../reticle-connect';");
    expect(source).toMatch(/<ReticleConnect \/>\n\s*<Scripts \/>/);
  });

  it('is idempotent', () => {
    const again = steps(Framework.TANSTACK_START, UiLibrary.REACT, {
      tanstackStartRoot: root,
      tanstackStartRootSource: written(plan, root),
      tanstackStartConnectExists: true,
    });
    const connectWrites = again.filter(
      (s) => s.write !== undefined && s.target !== 'src/reticle-dev.ts' && s.target !== 'vite.config.ts',
    );
    expect(connectWrites).toEqual([]);
  });

  it('falls back to the recipe for a root it cannot see <Scripts /> in', () => {
    const manual = steps(Framework.TANSTACK_START, UiLibrary.REACT, {
      tanstackStartRoot: root,
      tanstackStartRootSource: 'export const Route = createRootRoute({});\n',
    });
    const step = manual.find((s) => s.title === StepTitle.CONNECT_SNIPPET_TANSTACK_START);
    expect(step?.status).toBe(StepStatus.MANUAL);
    // The recipe names what the current template has, not an `App` component it lacks.
    expect(step?.detail).not.toContain('App component');
    expect(step?.detail).toContain('<Scripts />');
    expect(step?.detail).toContain('declare const __RETICLE_TOKEN__');
    expect(manual.some((s) => 'src/reticle-connect.tsx' === s.write?.path)).toBe(false);
  });
});

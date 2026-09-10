/**
 * #678: React Router framework mode renders HTML through its own request handler.
 *
 * The Vite plugin's non-desktop injection is a `transformIndexHtml` hook, which framework mode never
 * calls. `init` wired `vite.config.ts` and `src/reticle-dev.ts`, reported every step green, and the
 * page never got the connect script — confirmed by a reporter curling the SSR'd HTML (no
 * `reticle-connect` string anywhere) against a daemon showing zero sessions for 20+ minutes.
 *
 * Exactly the class SvelteKit and Astro are already detected for, and detected in the same place.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, UiLibrary, type DetectInput } from './detect.js';
import { frameworkPackages } from './plan.js';
import { reactRouterSteps } from './plan-framework.js';
import { REACT_ROUTER_ENTRY_PATH } from './snippets.js';
import { StepStatus, type PlanInput } from './plan.js';
import { isConnectStep } from './connect-steps.js';

const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
  ...over,
});

describe('detecting React Router framework mode', () => {
  it('keys on @react-router/dev', () => {
    const detection = detect(
      input({ pkg: { devDependencies: { '@react-router/dev': '^7.0.0', vite: '^6.0.0' } } }),
    );
    expect(detection.framework).toBe(Framework.REACT_ROUTER);
  });

  it('keys on react-router.config.ts', () => {
    const detection = detect(
      input({
        configFiles: new Set(['react-router.config.ts', 'vite.config.ts']),
        pkg: { dependencies: { 'react-router': '^7.0.0' } },
      }),
    );
    expect(detection.framework).toBe(Framework.REACT_ROUTER);
  });

  it('wins over the generic Vite branch, which is the whole point', () => {
    // On `main` this app is Framework.VITE: the plugin is wired, every step is green, and nothing
    // ever injects connect() into a page React Router renders itself.
    const detection = detect(
      input({
        pkg: { devDependencies: { '@react-router/dev': '^7.0.0', vite: '^6.0.0' } },
        configFiles: new Set(['vite.config.ts']),
      }),
    );
    expect(detection.framework).not.toBe(Framework.VITE);
  });

  it('leaves LIBRARY mode on the Vite path', () => {
    // `react-router` as a plain dependency renders through its own index.html, which the plugin does
    // reach. Treating it as framework mode would replace a working injection with a manual step.
    const detection = detect(
      input({
        pkg: {
          dependencies: { 'react-router': '^7.0.0', react: '^19.0.0' },
          devDependencies: { vite: '^6.0.0' },
        },
        configFiles: new Set(['vite.config.ts']),
      }),
    );
    expect(detection.framework).toBe(Framework.VITE);
  });

  it('leaves Next alone, which also owns its own rendering', () => {
    const detection = detect(
      input({ pkg: { dependencies: { next: '^15.0.0', 'react-router': '^7.0.0' } } }),
    );
    expect(detection.framework).toBe(Framework.NEXT);
  });
});

describe('what init installs for it', () => {
  it('is the React kit and the Vite plugin', () => {
    // Framework mode IS a Vite app rendering React. Only the connect injection differs, and the
    // plugin is still what stamps data-reticle-source — without it every verdict loses file:line.
    expect(frameworkPackages(Framework.REACT_ROUTER, UiLibrary.REACT)).toEqual([
      '@reticlehq/react',
      '@reticlehq/vite-plugin',
    ]);
  });
});

describe('the connect step it plans', () => {
  const planInput = (entry: { path: string; source: string } | null): PlanInput =>
    ({
      detection: detect(input({ pkg: { devDependencies: { '@react-router/dev': '^7.0.0' } } })),
      claudeCli: false,
      mcpExists: false,
      options: { port: 4400, projectId: 'demo' },
      reactRouterEntryExists: entry !== null,
      reactRouterEntrySource: entry?.source ?? null,
      testids: ['checkout-submit'],
    }) as unknown as PlanInput;

  const DEFAULT_ENTRY = `import { HydratedRouter } from 'react-router/dom';
import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
`;

  it('WRITES the client entry rather than printing it', () => {
    // #678 happened here: every step green, zero sessions. A recipe nobody applies is the same
    // outcome as no recipe, so the file is written.
    const [step] = reactRouterSteps(planInput(null));
    expect(step?.target).toBe(REACT_ROUTER_ENTRY_PATH);
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.path).toBe(REACT_ROUTER_ENTRY_PATH);
  });

  it('is a CONNECT step, so a warning on it fails init instead of reading as advice', () => {
    const [step] = reactRouterSteps(planInput(null));
    expect(isConnectStep(step?.title ?? '')).toBe(true);
  });

  it('hydrates as well as connects, because the file it writes is an OVERRIDE', () => {
    // `app/entry.client.tsx` overrides a default React Router supplies. A file containing only our
    // import would replace that default with one that never hydrates: an app that connects to
    // Reticle and renders nothing.
    const content = reactRouterSteps(planInput(null))[0]?.write?.content ?? '';
    expect(content).toContain('hydrateRoot');
    expect(content).toContain('HydratedRouter');
    expect(content).toContain("import('/@reticle-connect')");
  });

  it('adds one line to an entry the app already has, keeping everything in it', () => {
    const step = reactRouterSteps(
      planInput({ path: REACT_ROUTER_ENTRY_PATH, source: DEFAULT_ENTRY }),
    )[0];
    expect(step?.status).toBe(StepStatus.APPLY);
    const content = step?.write?.content ?? '';
    expect(content).toContain("import('/@reticle-connect')");
    expect(content).toContain('HydratedRouter');
    // Their file, plus one line — not a rewrite.
    for (const line of DEFAULT_ENTRY.trim().split('\n')) expect(content).toContain(line);
  });

  it('is idempotent — a second run adds nothing', () => {
    const once = reactRouterSteps(
      planInput({ path: REACT_ROUTER_ENTRY_PATH, source: DEFAULT_ENTRY }),
    )[0];
    const twice = reactRouterSteps(
      planInput({ path: REACT_ROUTER_ENTRY_PATH, source: once?.write?.content ?? '' }),
    )[0];
    expect(twice?.status).toBe(StepStatus.ALREADY);
  });

  it('says why the plugin alone cannot do it', () => {
    const detail = reactRouterSteps(planInput(null))[0]?.detail ?? '';
    expect(detail).toContain('own request handler');
  });
});

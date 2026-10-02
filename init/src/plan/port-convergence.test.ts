/**
 * Re-running `init --port <new>` over a project already wired on another port.
 *
 * Reproduced from a fresh install: every step read "already", nothing was rewritten, setup started
 * the daemon on the new port and the page went on dialling the old one — "never dialled the
 * bridge", over a report with nothing but green in it. Every place `init` writes a port must move
 * with the flag, and nothing may move without it.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput, type Step } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from '@/detect/detect.js';
import { newViteConfig } from '@/patch/vite-config.js';
import { nextReticleDevFile, svelteKitHooksFile } from '@/patch/snippets.js';
import { nuxtPluginFile } from '@/patch/nuxt-snippets.js';
import { retargetConfigPort, retargetPort } from './port-steps.js';
import { runInit, type InitOptions } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import { withStaticSnippet } from '@/patch/static-page.js';
import { tanstackStartConnectFile, tanstackStartConnectPath } from '@/patch/tanstack-start.js';
import { astroReticleDevFile } from '@/patch/astro-patch.js';
import { craDevModuleFile } from '@/patch/cra.js';
import { patchAngularMain } from '@/patch/angular.js';
import { PatchKind } from '@/patch/patch-kind.js';

const OLD = 4688;
const NEW = 4689;

function detection(framework: Framework): Detection {
  return {
    framework,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    packageManager: PackageManager.PNPM,
  };
}

function plan(framework: Framework, port: number | undefined, over: Partial<PlanInput> = {}) {
  return buildPlan({
    detection: detection(framework),
    claudeCli: false,
    mcpExists: true,
    viteConfig: null,
    nextConfigFile: null,
    nextReticleDevExists: false,
    reticleConfigExists: true,
    reticleConfigSource: `${JSON.stringify({ framework, projectId: 'demo', port: OLD }, null, 2)}\n`,
    options: { port, mcp: false, install: false, projectId: 'demo' },
    ...over,
  });
}

const step = (steps: readonly Step[], target: string): Step | undefined =>
  steps.find((s) => s.target === target && s.write !== undefined) ??
  steps.find((s) => s.target === target);

const viteConfig = { path: 'vite.config.ts', source: newViteConfig(OLD) };

describe('a new --port moves every port init wrote', () => {
  it('rewrites .reticle.json, keeping every other field', () => {
    const config = step(plan(Framework.VITE, NEW, { viteConfig }).steps, '.reticle.json');
    expect(config?.status).toBe(StepStatus.APPLY);
    expect(config?.detail).toContain(`port ${String(OLD)} → ${String(NEW)}`);
    expect(JSON.parse(config?.write?.content ?? '{}')).toEqual({
      framework: Framework.VITE,
      projectId: 'demo',
      port: NEW,
    });
  });

  it('rewrites the reticle({ port }) literal in the Vite config', () => {
    const cfg = step(plan(Framework.VITE, NEW, { viteConfig }).steps, 'vite.config.ts');
    expect(cfg?.status).toBe(StepStatus.APPLY);
    expect(cfg?.detail).toContain(`port ${String(OLD)} → ${String(NEW)}`);
    expect(cfg?.write?.content).toContain(`port: ${String(NEW)}`);
    expect(cfg?.write?.content).not.toContain(String(OLD));
  });

  it("rewrites the URL baked into Next's reticle-dev component", () => {
    const source = nextReticleDevFile(OLD, 'demo');
    const dev = step(
      plan(Framework.NEXT, NEW, {
        nextReticleDevExists: true,
        nextReticleDevSource: source,
        nextReticleDevPath: 'app/reticle-dev.tsx',
      }).steps,
      'app/reticle-dev.tsx',
    );
    expect(dev?.status).toBe(StepStatus.APPLY);
    expect(dev?.write?.content).toContain(`ws://localhost:${String(NEW)}/reticle`);
    expect(dev?.write?.content).not.toContain(`ws://localhost:${String(OLD)}/reticle`);
  });

  it('rewrites the URL in the SvelteKit client hook', () => {
    const hook = step(
      plan(Framework.SVELTEKIT, NEW, {
        svelteKitHooksExists: true,
        svelteKitHooksSource: svelteKitHooksFile(OLD, 'demo'),
      }).steps,
      'src/hooks.client.ts',
    );
    expect(hook?.status).toBe(StepStatus.APPLY);
    expect(hook?.write?.content).toContain(`ws://localhost:${String(NEW)}/reticle`);
  });

  it('gives a default-port hook the URL it now needs', () => {
    // A 4400 install bakes no URL at all, so there is no literal to rewrite — and the SDK's default
    // would go on dialling 4400.
    const moved = retargetPort(svelteKitHooksFile(undefined, 'demo'), NEW);
    expect(moved?.from).toBe(4400);
    expect(moved?.code).toContain(`url: 'ws://localhost:${String(NEW)}/reticle'`);
  });

  it('rewrites the URL in the Nuxt client plugin', () => {
    expect(retargetPort(nuxtPluginFile(OLD, 'demo'), NEW)?.code).toContain(
      `ws://localhost:${String(NEW)}/reticle`,
    );
  });

  it('drops the port field when moving back onto the default', () => {
    const moved = retargetConfigPort(JSON.stringify({ framework: 'vite', port: OLD }), 4400);
    expect(JSON.parse(moved?.code ?? '{}')).toEqual({ framework: 'vite' });
  });
});

describe('nothing moves without a change', () => {
  it('leaves every file alone when the port is the one already written', () => {
    const steps = plan(Framework.VITE, OLD, { viteConfig }).steps;
    expect(step(steps, '.reticle.json')?.status).toBe(StepStatus.ALREADY);
    expect(step(steps, 'vite.config.ts')?.status).toBe(StepStatus.ALREADY);
  });

  it('leaves every file alone when no --port was passed at all', () => {
    // A re-run without the flag must not quietly reset a project to the default port.
    const steps = plan(Framework.VITE, undefined, { viteConfig }).steps;
    expect(step(steps, '.reticle.json')?.status).toBe(StepStatus.ALREADY);
    expect(step(steps, 'vite.config.ts')?.status).toBe(StepStatus.ALREADY);
  });
});

/**
 * The three paths that write a bridge URL outside the plan's per-framework files: the snippet init
 * writes INTO a static page, the same page under a package.json with no UI library, and Angular's
 * browser entry. Each used to answer "already" to a re-run with a new `--port` without reading the
 * port inside the file, so the page went on dialling the daemon that was no longer there.
 */
describe('the static page and the Angular entry move with --port too', () => {
  const PAGE = '<!doctype html>\n<html>\n  <body>\n    <h1>Hi</h1>\n  </body>\n</html>\n';
  const ANGULAR_FILES: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'ngapp',
      scripts: { start: 'ng serve' },
      dependencies: { '@angular/core': '^22.2.0' },
      devDependencies: { '@angular/build': '^22.2.0', '@angular/cli': '^22.2.0' },
    }),
    'angular.json': JSON.stringify({
      version: 1,
      projects: {
        ngapp: {
          architect: {
            build: { builder: '@angular/build:application', options: { browser: 'src/main.ts' } },
            serve: { builder: '@angular/build:dev-server' },
          },
        },
      },
    }),
    'tsconfig.json': '{}\n',
    'src/main.ts': "import { bootstrapApplication } from '@angular/platform-browser';\n",
  };
  const opts = (port: number | undefined): InitOptions => ({
    cwd: '/app',
    port,
    mcp: false,
    install: false,
    dryRun: false,
  });
  /** Run init at OLD, then again over what it wrote with `port`, and return the second run's io. */
  const rerun = (files: Record<string, string>, port: number | undefined) => {
    const first = memoryIo(files);
    runInit(opts(OLD), first);
    const again = memoryIo({ ...files, ...first.written });
    runInit(opts(port), again);
    return { first, again };
  };

  it('rewrites the URL in the snippet written into a static index.html', () => {
    const { first, again } = rerun({ 'index.html': PAGE }, NEW);
    expect(first.written['index.html']).toContain(`ws://localhost:${String(OLD)}/reticle`);
    expect(again.written['index.html']).toContain(`ws://localhost:${String(NEW)}/reticle`);
    expect(again.written['index.html']).not.toContain(`:${String(OLD)}/`);
  });

  it('rewrites the URL in the Angular browser entry', () => {
    const { first, again } = rerun(ANGULAR_FILES, NEW);
    expect(first.written['src/main.ts']).toContain(`ws://localhost:${String(OLD)}/reticle`);
    expect(again.written['src/main.ts']).toContain(`ws://localhost:${String(NEW)}/reticle`);
    expect(again.written['src/main.ts']).not.toContain(`:${String(OLD)}/`);
  });

  it('moves a snippet in index.html under a package.json with no UI library', () => {
    const html =
      withStaticSnippet(PAGE, `{ url: 'ws://localhost:${String(OLD)}/reticle', projectId: 'demo' }`) ??
      '';
    const steps = plan(Framework.HTML, NEW, { htmlIndexSource: html }).steps;
    const index = step(steps, 'index.html');
    expect(index?.status).toBe(StepStatus.APPLY);
    expect(index?.write?.content).toContain(`ws://localhost:${String(NEW)}/reticle`);
  });

  it('leaves both alone on a re-run with no --port', () => {
    expect(rerun({ 'index.html': PAGE }, undefined).again.written['index.html']).toBeUndefined();
    expect(rerun(ANGULAR_FILES, undefined).again.written['src/main.ts']).toBeUndefined();
  });

  it('bakes no URL at all on the default port, like every other path', () => {
    const page = memoryIo({ 'index.html': PAGE });
    runInit(opts(undefined), page);
    expect(page.written['index.html']).not.toContain('ws://');
    const ng = memoryIo(ANGULAR_FILES);
    runInit(opts(undefined), ng);
    expect(ng.written['src/main.ts']).toContain("import('@reticlehq/browser')");
    expect(ng.written['src/main.ts']).not.toContain('ws://');
  });
});

/**
 * A re-run with the SAME non-default port used to duplicate the `url:` key in every generated
 * connect file: nothing moved, so the rewrite fell through to "give the connect call the URL it now
 * needs" and inserted a second one beside the first — `TS1117: An object literal cannot have
 * multiple properties with the same name`, and `next build` failed.
 */
describe('a re-run on the port already written changes nothing', () => {
  const angularMain = (port: number | undefined): string => {
    const patch = patchAngularMain('bootstrapApplication(App);\n', port, 'demo');
    return PatchKind.APPLY === patch.kind ? patch.code : '';
  };
  const GENERATED: Record<string, (port: number | undefined) => string> = {
    next: (port) => nextReticleDevFile(port, 'demo'),
    sveltekit: (port) => svelteKitHooksFile(port, 'demo'),
    nuxt: (port) => nuxtPluginFile(port, 'demo'),
    'tanstack-start': (port) => tanstackStartConnectFile(port, 'demo'),
    astro: (port) => astroReticleDevFile(port, 'demo'),
    cra: (port) => craDevModuleFile(port, 'demo'),
    angular: angularMain,
  };
  const urls = (code: string): number => code.split('ws://localhost:').length - 1;

  for (const [kind, generate] of Object.entries(GENERATED)) {
    it(`${kind}: the same --port is null, and a move keeps exactly one url`, () => {
      expect(retargetPort(generate(NEW), NEW)).toBeNull();
      expect(retargetPort(generate(undefined), undefined)).toBeNull();
      expect(retargetPort(generate(NEW), undefined)).toBeNull();
      const moved = retargetPort(generate(OLD), NEW);
      expect(moved?.code).toContain(`ws://localhost:${String(NEW)}/reticle`);
      expect(urls(moved?.code ?? '')).toBe(1);
      // Moved, then re-run at the port it was moved to: still one url, nothing to write.
      expect(retargetPort(moved?.code ?? '', NEW)).toBeNull();
    });
  }
});

/**
 * TanStack Start's connect component answered "file exists" to a new `--port` without reading the
 * port inside it, so the page went on dialling the daemon that had moved.
 */
describe("TanStack Start's connect component moves with --port", () => {
  const ROOT = 'src/routes/__root.tsx';
  const ROOT_SOURCE = `export function RootDocument() {\n  return (\n    <html>\n      <body>\n        <Scripts />\n      </body>\n    </html>\n  );\n}\n`;
  const connectPath = tanstackStartConnectPath(ROOT);
  const startPlan = (written: number, port: number | undefined) =>
    plan(Framework.TANSTACK_START, port, {
      tanstackStartRoot: ROOT,
      tanstackStartRootSource: ROOT_SOURCE,
      tanstackStartConnectExists: true,
      tanstackStartConnectSource: tanstackStartConnectFile(written, 'demo', ROOT),
    }).steps;

  it('rewrites the URL baked into it', () => {
    const connect = step(startPlan(OLD, NEW), connectPath);
    expect(connect?.status).toBe(StepStatus.APPLY);
    expect(connect?.detail).toContain(`port ${String(OLD)} → ${String(NEW)}`);
    expect(connect?.write?.content).toContain(`ws://localhost:${String(NEW)}/reticle`);
    expect(connect?.write?.content).not.toContain(`:${String(OLD)}/`);
  });

  it('leaves it alone on the same port or with no --port', () => {
    expect(step(startPlan(NEW, NEW), connectPath)?.status).toBe(StepStatus.ALREADY);
    expect(step(startPlan(OLD, undefined), connectPath)?.status).toBe(StepStatus.ALREADY);
  });
});

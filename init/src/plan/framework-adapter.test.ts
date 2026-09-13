/**
 * Adding a framework used to mean editing nine places, and only two of them went red when missed.
 *
 * The registry is the completion device: one `Record<Framework, FrameworkAdapter>` the compiler
 * refuses to leave a hole in, plus the two tables below that cannot be folded into it without a
 * module cycle (`FRAMEWORK_SIGNALS` and `DETECTION_ORDER` in `detect.ts`, which the plan builders
 * transitively import) and are therefore asserted complete here instead.
 *
 * The half nothing else can see is `connectStepTitles`: `connect-steps.ts` decides whether `init`
 * exits non-zero over an app that can never dial the daemon, and it does so from a hand-written
 * set. A framework whose connect step is absent from that set reports ⚠ and exits 0 — the
 * SvelteKit and React Router shape again, one layer further on.
 */

import { describe, expect, it } from 'vitest';
import { detect, Framework, FRAMEWORK_SIGNALS, DETECTION_ORDER, UiLibrary } from '../detect/detect.js';
import { FRAMEWORK_ADAPTERS } from './framework-adapter.js';
import { CONNECT_STEP_TITLES, StepTitle } from './connect-steps.js';
import { frameworkPackages, type PlanInput } from './plan.js';
import { APP_DEPS } from '../detect/workspace-apps.js';
import { CSP_FILES } from '../diagnose/csp-doctor.js';

const ALL_FRAMEWORKS: readonly Framework[] = Object.values(Framework);

const planFor = (framework: Framework): PlanInput => ({
  detection: {
    ...detect({ pkg: {}, configFiles: new Set<string>(), lockfiles: new Set<string>() }),
    framework,
  },
  claudeCli: false,
  mcpExists: false,
  viteConfig: null,
  nextConfigFile: null,
  nextReticleDevExists: false,
  options: { port: 4400, mcp: false, install: true, projectId: 'demo' },
});

describe('the framework registry', () => {
  it('has an entry for every framework the detector can return', () => {
    for (const framework of ALL_FRAMEWORKS) {
      expect(Object.keys(FRAMEWORK_ADAPTERS), framework).toContain(framework);
    }
    expect(Object.keys(FRAMEWORK_ADAPTERS).sort()).toEqual([...ALL_FRAMEWORKS].sort());
  });

  it('gives every entry a package list, a step builder and at least one connect step', () => {
    for (const framework of ALL_FRAMEWORKS) {
      const adapter = FRAMEWORK_ADAPTERS[framework];
      expect(adapter.packages('@reticlehq/react').length, framework).toBeGreaterThan(0);
      expect(adapter.steps(planFor(framework)).length, framework).toBeGreaterThan(0);
      expect(adapter.connectStepTitles.length, framework).toBeGreaterThan(0);
    }
  });

  /**
   * A connect title the adapter names but `connect-steps.ts` does not know is a ⚠ that exits 0.
   * `PAIRING_TOKEN` is the one deliberate exclusion the other way — see the comment that names it.
   */
  it('names only connect titles that make init fail loudly', () => {
    for (const framework of ALL_FRAMEWORKS) {
      for (const title of FRAMEWORK_ADAPTERS[framework].connectStepTitles) {
        expect(CONNECT_STEP_TITLES.has(title), `${framework}: ${title}`).toBe(true);
      }
    }
  });

  it('covers every connect title except the one deliberately excluded', () => {
    const claimed = new Set<StepTitle>(
      ALL_FRAMEWORKS.flatMap((f) => [...FRAMEWORK_ADAPTERS[f].connectStepTitles]),
    );
    const orphaned = [...CONNECT_STEP_TITLES].filter(
      (t) => t !== StepTitle.PAIRING_TOKEN && !claimed.has(t),
    );
    expect(orphaned).toEqual([]);
  });

  /** The registry is the plan's source, not a second opinion on it. */
  it('is what frameworkPackages answers from', () => {
    for (const framework of ALL_FRAMEWORKS) {
      expect(frameworkPackages(framework, UiLibrary.REACT), framework).toEqual(
        FRAMEWORK_ADAPTERS[framework].packages('@reticlehq/react'),
      );
    }
  });

  /** Each framework actually plans the connect step it claims to depend on. */
  it('plans at least one of the connect steps it names', () => {
    for (const framework of ALL_FRAMEWORKS) {
      const adapter = FRAMEWORK_ADAPTERS[framework];
      const titles = new Set(adapter.steps(planFor(framework)).map((s) => s.title));
      expect(
        adapter.connectStepTitles.some((t) => titles.has(t)),
        `${framework} plans none of ${adapter.connectStepTitles.join(', ')}`,
      ).toBe(true);
    }
  });
});

/**
 * The detection half. It lives in `detect.ts` rather than in the adapter because the plan builders
 * the adapter holds import `detect.ts` transitively, and merging the two would make the module that
 * answers "what is this project" depend on the module that answers "how do we wire it".
 */
describe('the detection table', () => {
  it('has signals for every framework', () => {
    expect(Object.keys(FRAMEWORK_SIGNALS).sort()).toEqual([...ALL_FRAMEWORKS].sort());
  });

  /**
   * `DETECTION_ORDER` is the precedence chain. A framework missing from it is never detected at all,
   * which is silent: the app is classified as whatever matches next and wired for that instead.
   */
  it('tries every framework that has a signal, in a fixed order', () => {
    const ordered = new Set<Framework>(DETECTION_ORDER);
    for (const framework of ALL_FRAMEWORKS) {
      const signals = FRAMEWORK_SIGNALS[framework];
      const hasSignal = signals.deps.length > 0 || signals.configs.length > 0;
      expect(ordered.has(framework), `${framework} (signals: ${String(hasSignal)})`).toBe(
        hasSignal,
      );
    }
    expect(DETECTION_ORDER.length).toBe(new Set(DETECTION_ORDER).size);
  });
});

/**
 * The two per-framework tables that are deliberately NOT in the registry, and the guard that keeps
 * that deliberate.
 *
 * Both were flagged as detection fragmentation. Neither should be consolidated, and the reasons are
 * different in kind:
 *
 * - `APP_DEPS` asks "is this directory a runnable app", not "which framework is it". Its answer is
 *   already reached three ways (a bundler config, one of these deps, or a dev script), and the third
 *   catches every framework the first two miss. Widening it to every dep in `FRAMEWORK_SIGNALS` —
 *   now mechanically possible, which it was not before that table existed — would change WHICH
 *   directory the monorepo redirect picks, and no gate scaffolds a monorepo.
 * - `CSP_FILES` needs a per-framework PARSER, not a filename. Next, Vite and CRA declare a policy in
 *   a file this module can regex; Nuxt puts it in `routeRules`, SvelteKit under `kit.csp`, and both
 *   are structured config a filename cannot read. Naming the file without being able to read it
 *   would produce findings on config that is not a CSP at all.
 *
 * So: a completeness guard rather than a consolidation. Every framework must be consciously present
 * or consciously absent from each table, with the absence written down.
 */
describe('the tables the registry deliberately does not own', () => {
  /** Deps of this framework that `APP_DEPS` carries, or why it carries none of them. */
  const APP_DEP_COVERAGE: Record<Framework, readonly string[] | string> = {
    [Framework.NEXT]: ['next'],
    [Framework.VITE]: ['vite'],
    [Framework.ELECTRON_VITE]: ['electron-vite'],
    [Framework.TANSTACK_START]:
      'reached by the vite.config check, which `looksLikeApp` runs before the deps — Start is a ' +
      'Vite app and always ships one',
    [Framework.NUXT]:
      'a Nuxt app always has a dev script, which `looksLikeApp` already accepts; adding `nuxt` here ' +
      'would widen the monorepo redirect with nothing to prove it against',
    [Framework.SVELTEKIT]: 'same as Nuxt — reached by the dev-script check',
    [Framework.ASTRO]: 'same as Nuxt — reached by the dev-script check',
    [Framework.REACT_ROUTER]:
      'reached by the vite.config check, which `looksLikeApp` runs before the deps',
    [Framework.CRA]: 'reached by the dev-script check; react-scripts apps always declare `start`',
    [Framework.HTML]: 'not an npm-shaped app at all — there is no dependency that names it',
  };

  it('names every framework as present in or absent from APP_DEPS', () => {
    const appDeps = new Set<string>(APP_DEPS);
    for (const framework of ALL_FRAMEWORKS) {
      const coverage = APP_DEP_COVERAGE[framework];
      if ('string' === typeof coverage) {
        expect(coverage.length, framework).toBeGreaterThan(0);
        // An absence that stops being true has to be rewritten as a presence, not left as prose.
        for (const dep of FRAMEWORK_SIGNALS[framework].deps) {
          expect(appDeps.has(dep), `${framework}: '${dep}' is in APP_DEPS now`).toBe(false);
        }
        continue;
      }
      expect(coverage.length, framework).toBeGreaterThan(0);
      for (const dep of coverage) {
        expect(appDeps.has(dep), `${framework}: '${dep}'`).toBe(true);
        expect(FRAMEWORK_SIGNALS[framework].deps, framework).toContain(dep);
      }
    }
  });

  /** `CSP_FILES` entries that carry this framework's policy, or why none can. */
  const CSP_COVERAGE: Record<Framework, readonly string[] | string> = {
    [Framework.NEXT]: ['next.config.mjs', 'middleware.ts', 'app/layout.tsx', 'pages/_document.tsx'],
    [Framework.VITE]: ['index.html'],
    [Framework.ELECTRON_VITE]: ['src/renderer/index.html'],
    [Framework.CRA]: ['public/index.html'],
    [Framework.HTML]: ['index.html'],
    [Framework.TANSTACK_START]:
      'Start SSRs its document from `__root.tsx`, so a policy lives in that route module rather ' +
      'than in a file this module can regex',
    [Framework.NUXT]:
      'Nuxt declares CSP as structured `routeRules` headers in nuxt.config, which needs a parser — ' +
      'a regex over that file would report on config that is not a policy',
    [Framework.SVELTEKIT]:
      'SvelteKit declares it under `kit.csp` in svelte.config.js — same parser',
    [Framework.ASTRO]:
      'Astro has no one policy site: a middleware, an adapter header, or a per-page meta tag',
    [Framework.REACT_ROUTER]:
      'declared in the request handler the app owns, so there is no fixed file to read',
  };

  it('names every framework as present in or absent from CSP_FILES', () => {
    for (const framework of ALL_FRAMEWORKS) {
      const coverage = CSP_COVERAGE[framework];
      if ('string' === typeof coverage) {
        expect(coverage.length, framework).toBeGreaterThan(0);
        continue;
      }
      expect(coverage.length, framework).toBeGreaterThan(0);
      for (const file of coverage) expect(CSP_FILES, `${framework}: ${file}`).toContain(file);
    }
  });
});

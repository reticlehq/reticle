import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
// The same derivation the other repo-wide checks use, so they cannot disagree about what exists.
import { workspaceGlobs } from '../../../../scripts/check-boundaries.mjs';
import { REPO_ROOT } from '../../machine/repo-root.js';

const REPO = REPO_ROOT;

/**
 * Every integration we SHIP has an app that exercises it, and a gate that runs that app.
 *
 * This is the rule `apps/` never stated, which is why it accumulated: apps arrived for a reason and
 * then nothing recorded whether that reason was still being served. The Astro and Remix examples
 * wire the SDK for real (Astro connects a different way, because it SSRs its own HTML so the
 * plugin's index.html injection never fires) and are driven by the integration battery — which is
 * why they can be offered in SKILL.md at all.
 *
 * The failure mode this prevents is shipping a broken integration, and discipline does not prevent it
 * — a red build does. Adding `packages/svelte` with no app and no spec fails here, at the moment the
 * package is added, rather than in a user's bug report.
 *
 * A thin app is CORRECT for this job: `electron-smoke` is 290 lines because its job is to prove the
 * wiring works, not to be an application. Size is not the measure; coverage is.
 */

/** Integration packages: ones a USER installs to wire Reticle into their app. */
const INTEGRATIONS = ['react', 'next', 'vite', 'babel-plugin', 'electron', 'tauri'] as const;

/**
 * Which app proves each integration, and which gate runs that app. `null` = a known, deliberate hole
 * — it must be listed WITH its reason, never left implicit, so the gap is visible in review.
 */
const COVERAGE: Record<
  string,
  { app: string; gate: string } | { app: string; gate: null; why: string }
> = {
  react: { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  // Keyed by the directory it lives in. Published as `@reticlehq/vite-plugin`.
  vite: { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  'babel-plugin': { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  next: { app: 'apps/next-smoke', gate: 'apps/e2e/specs/next-smoke-test.mjs' },
  electron: { app: 'apps/electron-smoke', gate: 'apps/e2e/specs/electron-desktop-test.mjs' },
  tauri: { app: 'apps/tauri-smoke', gate: 'apps/e2e/specs/tauri-desktop-test.mjs' },
};

/** The electron-vite path is a second Electron app, not a second package. Declared so it cannot go dark. */
const ELECTRON_VITE_COVERAGE = {
  app: 'apps/electron-vue-pinia',
  gate: 'apps/e2e/specs/electron-vite-desktop-test.mjs',
};

/**
 * The name of every package this repo publishes, wherever it lives.
 *
 * Read from the pnpm workspace file rather than by listing one directory. Not everything lives under
 * `packages/` any more -- the realms and the build plugins are grouped by what they are -- and a
 * scan that looks in one place goes on reporting success about what it can still see. This check in
 * particular would then say every integration is covered while quietly not looking at most of them.
 */
function shippedPackages(): string[] {
  const yaml = readFileSync(join(REPO, 'pnpm-workspace.yaml'), 'utf8');
  const names: string[] = [];
  for (const glob of workspaceGlobs(yaml)) {
    if (glob.startsWith('apps')) continue;
    const [head, ...rest] = glob.split('/');
    const here = join(REPO, head ?? '');
    if (!existsSync(here)) continue;
    const levels = rest.length;
    const walk = (dir: string, depth: number): void => {
      if (depth === levels) {
        // `basename`, not `split('/')`: on Windows `join` builds `…\\adapters\\build\\vite`, which
        // contains no forward slash at all, so the split returned the WHOLE PATH as the package
        // name and every entry missed the coverage map — reported as fourteen packages shipped
        // without coverage, which is the opposite of what was true.
        if (existsSync(join(dir, 'package.json'))) names.push(basename(dir));
        return;
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
      }
    };
    walk(here, 0);
  }
  return names;
}

describe('every shipped integration is covered by an app AND a gate', () => {
  it('finds the packages directory', () => {
    expect(shippedPackages().length).toBeGreaterThan(5);
  });

  it.each(INTEGRATIONS)('%s has a covering app that exists on disk', (pkg) => {
    const entry = COVERAGE[pkg];
    expect(entry, `no coverage declared for packages/${pkg}`).toBeDefined();
    expect(existsSync(join(REPO, entry?.app ?? '')), `${entry?.app} is missing`).toBe(true);
  });

  it.each(INTEGRATIONS)('%s has a gate that actually runs its app', (pkg) => {
    const entry = COVERAGE[pkg];
    if (entry !== undefined && 'why' in entry && null === entry.gate) {
      // A declared hole is allowed to exist, but not to be silent.
      expect(
        entry.why.length,
        `packages/${pkg} declares a coverage hole with no reason`,
      ).toBeGreaterThan(20);
      return;
    }
    expect(existsSync(join(REPO, entry?.gate ?? '')), `${entry?.gate} is missing`).toBe(true);
  });

  it('electron-vite has a covering app that a desktop spec drives', () => {
    expect(existsSync(join(REPO, ELECTRON_VITE_COVERAGE.app)), ELECTRON_VITE_COVERAGE.app).toBe(
      true,
    );
    expect(existsSync(join(REPO, ELECTRON_VITE_COVERAGE.gate)), ELECTRON_VITE_COVERAGE.gate).toBe(
      true,
    );
  });

  /**
   * A new integration package must not be able to arrive without coverage. This is the half that
   * makes the rest self-maintaining: the list above cannot silently fall behind what is published.
   */
  it('has no shipped integration package missing from the coverage map', () => {
    const known = new Set<string>([
      ...INTEGRATIONS,
      // Not integrations: the contract, the rules that decide a verdict, the specification they
      // implement, the realm the SDK itself is, the daemon, and dev tooling. None of these teaches
      // Reticle about somebody's framework or build tool, so none of them needs an app proving it.
      'core',
      'openreality',
      'engine',
      'dom',
      'server',
      'spec-runner',
      // The suite that scores an implementation of the specification. It teaches Reticle nothing
      // about anybody's framework, so there is no app it would be proven by.
      'conformance',
      // The lint rule we ship. Its directory is `eslint`, under `adapters/lint/`.
      'eslint',
      // The project scaffolder. It is what WIRES an integration, so every scaffold the install gate
      // drives is a test of it — but a user never installs it to wire a framework, and it has no app
      // of its own. `apps/e2e/install-gate.mjs` is its coverage.
      'init',
    ]);
    const unmapped = shippedPackages().filter((p) => !known.has(p));
    expect(
      unmapped,
      'a package was added without declaring how it is covered — add it to COVERAGE with an app and a gate, or to the non-integration list',
    ).toEqual([]);
  });

  /**
   * Every framework the skill OFFERS has an app and a gate. Vue and Svelte/SvelteKit used to be on
   * that list with neither — an unproven promise in the one file users actually paste — and they
   * were removed rather than quietly kept.
   *
   * `HAS_APP` is the whole point: adding an option to SKILL.md without adding its app here fails,
   * so the list cannot grow past what CI proves.
   */
  const HAS_APP: Record<string, { dir: string; gateToken: string }> = {
    'Vite + React': { dir: 'apps/bench-app', gateToken: 'bench-app' },
    'Next.js': { dir: 'apps/next-smoke', gateToken: 'next-smoke' },
    // The integration battery drives these two by PACKAGE name, not by path.
    Remix: { dir: 'apps/examples/remix', gateToken: '@reticlehq/example-remix' },
    Astro: { dir: 'apps/examples/astro', gateToken: '@reticlehq/example-astro' },
  };

  it('every framework SKILL.md offers has an app that a gate drives', () => {
    // The framework table lives in the setup companion now: it is setup-time guidance, and an
    // already-running agent should not pay to read it every session. Both files are read so that
    // moving a rule between them is a non-event, while dropping one entirely still fails.
    const skill = [
      readFileSync(join(REPO, 'SKILL.md'), 'utf8'),
      readFileSync(join(REPO, 'docs', 'skill-setup.md'), 'utf8'),
    ].join('\n');
    const offered = Object.keys(HAS_APP);
    const missingFromSkill = offered.filter((f) => !skill.includes(f));
    expect(missingFromSkill, 'SKILL.md dropped a framework — update HAS_APP deliberately').toEqual(
      [],
    );

    // The e2e specs cover React and Next; the integration battery covers Remix and Astro. Both are
    // gates, so read both — checking only one would report a covered framework as unproven.
    const specDir = join(REPO, 'apps/e2e/specs');
    const gates = [
      ...readdirSync(specDir).map((f) => readFileSync(join(specDir, f), 'utf8').toString()),
      readFileSync(join(REPO, 'test/frameworks.integration.test.ts'), 'utf8').toString(),
    ].join('\n');

    const missingApp = offered.filter((f) => !existsSync(join(REPO, HAS_APP[f]?.dir ?? '')));
    expect(missingApp.sort(), 'a framework is offered to users with no app on disk').toEqual([]);

    const unproven = offered.filter((f) => !gates.includes(HAS_APP[f]?.gateToken ?? ' '));
    expect(unproven.sort(), 'a framework is offered to users with no gate driving its app').toEqual(
      [],
    );
  });

  /**
   * The removal has to STAY removed. Re-adding Vue or Svelte to the skill is a support claim, and it
   * must arrive with an app and a gate — which the test above then enforces.
   */
  it('SKILL.md does not offer a framework we cannot prove', () => {
    // The framework table lives in the setup companion now: it is setup-time guidance, and an
    // already-running agent should not pay to read it every session. Both files are read so that
    // moving a rule between them is a non-event, while dropping one entirely still fails.
    const skill = [
      readFileSync(join(REPO, 'SKILL.md'), 'utf8'),
      readFileSync(join(REPO, 'docs', 'skill-setup.md'), 'utf8'),
    ].join('\n');
    const offeredOptions = skill
      .split('\n')
      .filter((line) => /^\s+[a-z]\)\s/.test(line))
      .join('\n');
    const claimed = ['Vue', 'Svelte', 'SvelteKit'].filter((f) => offeredOptions.includes(f));
    expect(
      claimed,
      'SKILL.md offers a framework with no app and no gate — add both, or do not offer it',
    ).toEqual([]);
  });
});

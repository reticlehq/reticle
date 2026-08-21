import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

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
const INTEGRATIONS = ['react', 'next', 'vite-plugin', 'babel-plugin', 'electron', 'tauri'] as const;

/**
 * Which app proves each integration, and which gate runs that app. `null` = a known, deliberate hole
 * — it must be listed WITH its reason, never left implicit, so the gap is visible in review.
 */
const COVERAGE: Record<
  string,
  { app: string; gate: string } | { app: string; gate: null; why: string }
> = {
  react: { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  'vite-plugin': { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  'babel-plugin': { app: 'apps/bench-app', gate: 'apps/e2e/specs/real-world-tests.mjs' },
  next: { app: 'apps/next-smoke', gate: 'apps/e2e/specs/next-smoke-test.mjs' },
  electron: { app: 'apps/electron-smoke', gate: 'apps/e2e/specs/electron-desktop-test.mjs' },
  tauri: { app: 'apps/tauri-smoke', gate: 'apps/e2e/specs/tauri-desktop-test.mjs' },
};

function shippedPackages(): string[] {
  return readdirSync(join(REPO, 'packages')).filter((p) =>
    existsSync(join(REPO, 'packages', p, 'package.json')),
  );
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

  /**
   * A new integration package must not be able to arrive without coverage. This is the half that
   * makes the rest self-maintaining: the list above cannot silently fall behind `packages/`.
   */
  it('has no shipped integration package missing from the coverage map', () => {
    const known = new Set<string>([
      ...INTEGRATIONS,
      // Not integrations: the contract, the SDK itself, the daemon, and dev tooling.
      'core',
      'browser',
      'server',
      'test',
      'eslint-plugin',
      // Private deployment target; its package-local tests and live smoke script cover the Worker.
      'cloudflare',
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
    const skill = readFileSync(join(REPO, 'SKILL.md'), 'utf8');
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
    const skill = readFileSync(join(REPO, 'SKILL.md'), 'utf8');
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

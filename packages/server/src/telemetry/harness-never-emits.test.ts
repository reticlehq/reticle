import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isReticleSourceCheckout } from './dev-repo.js';

/**
 * Our own harnesses must not appear in production telemetry.
 *
 * The source-checkout guard covers almost everything: it walks up from `cwd` for the monorepo's
 * `package.json`, so any harness run from inside this repo is silent. **`install-gate.mjs` is the
 * one that escapes it, by design** — it scaffolds pristine apps into the OS temp directory and
 * installs Reticle into them from a local Verdaccio, which is the entire point, and which means
 * those daemons are correctly NOT in a source checkout.
 *
 * So it emitted real events, and they were not a rounding error. Measured in one day of production
 * data: 308 CI rows from 19 distinct anonymous ids — every runner a brand-new "user" — carrying 144
 * of the 169 `init_completed` events and 19 `reticle_installed`. **Our own gate was the majority of
 * our own install funnel**, and because a release branch reports that branch's version, unreleased
 * versions showed up in production dashboards as though people were installing them.
 *
 * This is guarded here rather than trusted to review for the reason the whole telemetry contract
 * exists: nothing throws, no test reddens, and the pollution is only visible weeks later in a
 * dashboard nobody can retroactively clean.
 */
const GATE = fileURLToPath(new URL('../../../../apps/e2e/install-gate.mjs', import.meta.url));

describe('the install gate never phones home', () => {
  it('disables telemetry on its own process, so every child inherits it', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src, 'install-gate.mjs must disable telemetry').toMatch(
      /process\.env\.RETICLE_TELEMETRY\s*=\s*'0'/,
    );
  });

  it('sets it before anything is spawned', () => {
    // Per-spawn env is how the next call site added here quietly leaks. Setting it on the process,
    // above the first spawn, is what makes that impossible rather than merely unlikely.
    const src = readFileSync(GATE, 'utf8');
    const set = src.search(/process\.env\.RETICLE_TELEMETRY\s*=/);
    const firstSpawn = Math.min(
      ...[/\bspawn\(/, /\bexecFileSync\(/]
        .map((re) => src.search(re))
        .filter((i) => i >= 0)
        .concat([src.length]),
    );
    expect(set).toBeGreaterThan(-1);
    expect(set, 'the guard must precede the first spawn').toBeLessThan(firstSpawn);
  });

  it('declares itself a machine whoever runs it', () => {
    // `CI` is the only thing an event carries that says "not a person", and it is set by the runner
    // and by nothing else. A gate driven from a laptop or from a cloud agent sandbox therefore
    // landed in the data as a human at a machine — which is the shape our own gate traffic had.
    // Pinned as "CI ends up non-empty", NOT as one literal. The first version of this asserted
    // `CI = '1'`, and `1` is a value some tooling rejects: setting it in the desktop harness broke
    // `tauri build`, whose CLI reads CI as the value of its own `--ci` flag, and turned that gate red
    // on main. A test that pins a specific string blesses whichever string was written first.
    const src = readFileSync(GATE, 'utf8');
    expect(src, 'install-gate.mjs must set CI on its own process').toMatch(
      /process\.env\.CI\s*=\s*[^;]+;/,
    );
    expect(src, 'and must not clobber a value the runner already set').toMatch(
      /process\.env\.CI\s*=\s*process\.env\.CI\s*\?\?/,
    );
  });

  it('and the reason the gate needs its own guard still holds', () => {
    // If this ever fails, the checkout rule has changed and the gate may be covered by it after all
    // — at which point the guard above is belt-and-braces rather than load-bearing. Either way, know.
    expect(isReticleSourceCheckout('/tmp/some-scaffolded-app')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A suite that boots a REAL dev server must not have its result cached by turbo.
 *
 * Turbo caches `test:unit` on a hash of the package's files, which is sound only when the outcome is
 * a function of those files. This package's integration suite starts an actual Vite dev server and
 * binds a port, so its outcome also depends on the machine — memory pressure, a port already held,
 * a dev server from a previous run that never closed. Caching an outcome that is not a function of
 * its inputs is unsound in principle, and it was observed in practice (#140):
 *
 *   `pnpm test:unit` reported it GREEN in the same minute a direct
 *   `pnpm --filter @reticlehq/vite-plugin test:unit` reported it RED — turbo served a cached pass
 *   from an earlier run.
 *
 * That is the worst shape a gate can take: it reports success for a suite that is failing right now,
 * which is precisely when somebody is relying on it. Re-running this package costs ~6s.
 *
 * The rule is tied to the EVIDENCE rather than pinned to a filename: if any test here boots a
 * server, the opt-out must be present. Delete the integration suite and this stops demanding it;
 * add a second one and it is already covered.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');

/** Booting a real Vite dev server — the thing that makes a suite depend on the machine. */
const BOOTS_A_SERVER = /createServer|\.listen\(/;

function testFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(HERE, name));
}

describe('turbo must not cache a non-hermetic suite', () => {
  it('this package has at least one suite that boots a real server', () => {
    // Guards the guard: if this stops being true the rule below is vacuous, and a vacuous rule that
    // still passes is how a check quietly stops checking.
    const booting = testFiles().filter((f) => BOOTS_A_SERVER.test(readFileSync(f, 'utf8')));
    expect(booting.length).toBeGreaterThan(0);
  });

  it('so test:unit caching is disabled for this package', () => {
    const path = join(PKG, 'turbo.json');
    expect(existsSync(path), 'packages/vite-plugin/turbo.json must exist').toBe(true);
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks?: Record<string, { cache?: boolean }>;
    };
    expect(config.tasks?.['test:unit']?.cache).toBe(false);
  });
});

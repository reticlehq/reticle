import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { reticle } from './index.js';

/**
 * Regression guard for #165: Vite 8 (rolldown) rejects a top-level `define` inside
 * `optimizeDeps.rolldownOptions` and prints a warning on every dev boot. The fix places defines
 * under `transform.define` — this test boots a REAL Vite 8 dev server with a CJS dependency that
 * the optimizer must pre-bundle, forcing Rolldown to validate its input options. If `define` leaks
 * to the top level of `rolldownOptions`, Rolldown emits the warning here.
 *
 * A unit test on `optimizerOptions` already pins the function's output; this pins the CONTRACT
 * with the actual installed Vite, which is the part that broke silently.
 */

interface DevServerLike {
  listen: () => Promise<unknown>;
  close: () => Promise<void>;
  resolvedUrls?: { local: string[] };
}
type CreateServer = (inline: Record<string, unknown>) => Promise<DevServerLike>;

/**
 * `vite` is a declared dependency of this package, so failing to import it is not a condition to
 * tolerate — it is a broken workspace. Returning early on it instead made all four of these tests
 * run ZERO assertions and report green, which is the worst shape a guard can take: the thing it
 * protects (a clean dev boot, on every user's machine) would be unguarded and nothing would say so.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} did not resolve — this suite cannot prove anything without it`);
  }
  return value;
}

let createServer: CreateServer | undefined;

/**
 * Booting a real Vite dev server — with the optimizer FORCED, which is what makes the warning
 * reproducible at all — is not a 5-second operation on a loaded CI runner, and vitest's default is 5
 * seconds. So this suite went red on Windows for the machine's reasons, on pull requests that do not
 * touch this package at all, and the `gate` job aggregates it. A contributor whose docs change is
 * blocked by a Vite boot timing out learns to re-run until green, which is how a real failure gets
 * waved through.
 *
 * The invariant is "no warning is emitted", and no duration expresses that. A generous per-test
 * budget cannot weaken it: a run that emits the warning fails at any budget, and one that does not is
 * only ever slow. Same rule the repo already applies to its own timing assertions.
 */
const SERVER_BOOT_BUDGET_MS = 120_000;
const HOOK_TIMEOUT_MS = 60_000;
const CLOSE_BUDGET_MS = 5_000;

beforeAll(async () => {
  const vite = (await import('vite')) as { createServer: CreateServer };
  createServer = vite.createServer;
}, HOOK_TIMEOUT_MS);

describe('vite 8 dev boot with the plugin produces no define warnings (#165)', () => {
  const dirs: string[] = [];
  const servers: DevServerLike[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await Promise.race([
        server.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS)),
      ]);
    }
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows holds handles; a leaked temp dir is not a test failure */
      }
    }
    delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  }, HOOK_TIMEOUT_MS);

  /**
   * Create a minimal app tree with a CJS dependency that forces the dep optimizer to run.
   * The SDK is a CJS stub in node_modules (not an alias) so Vite pre-bundles it — which is the
   * code path where Rolldown validates its input options and emits the warning if `define` is at
   * the wrong level.
   */
  function makeMinimalApp(): string {
    const root = mkdtempSync(join(tmpdir(), 'reticle-vite8-define-'));

    // Fake vite/package.json so `viteMajor(root)` returns 8
    mkdirSync(join(root, 'node_modules', 'vite'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'vite', 'package.json'),
      JSON.stringify({ name: 'vite', version: '8.0.0', main: './index.js' }),
    );
    writeFileSync(join(root, 'node_modules', 'vite', 'index.js'), 'module.exports = {};');

    // The SDK as a CJS package — Vite must pre-bundle this since it's CommonJS.
    mkdirSync(join(root, 'node_modules', '@reticlehq', 'react'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', '@reticlehq', 'react', 'package.json'),
      JSON.stringify({
        name: '@reticlehq/react',
        version: '2.5.0',
        main: './index.cjs',
      }),
    );
    writeFileSync(
      join(root, 'node_modules', '@reticlehq', 'react', 'index.cjs'),
      'exports.reticle = { connect() {} };\nexports.install = function() {};\n',
    );

    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'index.html'),
      '<html><body><script type="module" src="/src/main.js"></script></body></html>',
    );
    writeFileSync(
      join(root, 'src', 'main.js'),
      "import { reticle } from '@reticlehq/react';\nreticle.connect();\n",
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '0.0.0' }),
    );
    return root;
  }

  it(
    'no "Invalid input options" warning for the define key',
    async () => {
      const create = required(createServer, 'vite.createServer');

      const root = makeMinimalApp();
      dirs.push(root);

      const tokenDir = mkdtempSync(join(tmpdir(), 'reticle-token-define-'));
      dirs.push(tokenDir);
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = tokenDir;

      const warnings: string[] = [];
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });

      const server = await create({
        root,
        configFile: false,
        server: { port: 0, host: '127.0.0.1' },
        // Force the optimizer to run — without this, a warm .vite cache skips Rolldown entirely
        // and the warning never fires even when the options are wrong.
        optimizeDeps: { force: true },
        plugins: [reticle()],
        customLogger: {
          info() {},
          warn(msg: string) {
            warnings.push(msg);
          },
          warnOnce(msg: string) {
            warnings.push(msg);
          },
          error() {},
          clearScreen() {},
          hasErrorLogged() {
            return false;
          },
          hasWarned: false,
        },
      });
      servers.push(server);
      await server.listen();

      // Fetch the entry to trigger dep discovery + pre-bundling of the CJS SDK stub.
      const base = server.resolvedUrls?.local[0] ?? '';
      if (base.length > 0) {
        await fetch(`${base.replace(/\/$/, '')}/src/main.js`).catch(() => undefined);
        // Allow the optimizer to process and emit any validation warnings.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      warnSpy.mockRestore();

      const defineWarnings = warnings.filter(
        (w) =>
          w.includes('Invalid input options') || (w.includes('define') && w.includes('Invalid')),
      );
      expect(
        defineWarnings,
        "Vite 8 must accept the plugin's optimizer options without a define warning. " +
          `Got: ${JSON.stringify(defineWarnings)}`,
      ).toEqual([]);
    },
    SERVER_BOOT_BUDGET_MS,
  );
});

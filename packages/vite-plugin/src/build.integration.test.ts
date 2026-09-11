import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, beforeAll } from 'vitest';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { reticle, RETICLE_CONNECT_MODULE, RETICLE_VITE_PLUGIN_NAME } from './index.js';

/**
 * Proves the prod-safety claim against Vite's *actual* config resolution rather than a unit
 * assertion on the `apply` field: `resolveConfig(..., 'build')` runs Vite's own apply-filter, so a
 * plugin missing from the resolved build pipeline can never touch a production bundle. Skipped when
 * `vite` is not installed (e.g. offline local runs); CI installs it as a devDependency.
 */

/** A dev server, as much of it as this suite drives. */
interface DevServerLike {
  listen: () => Promise<unknown>;
  close: () => Promise<void>;
  resolvedUrls?: { local: string[] };
}
type CreateServer = (inline: Record<string, unknown>) => Promise<DevServerLike>;

type ResolveConfig = (
  inline: { plugins: unknown[]; configFile: false; logLevel: 'silent' },
  command: 'build' | 'serve',
) => Promise<{ plugins: readonly { name: string }[] }>;

/**
 * Shared with the sibling integration suite: a declared dependency that does not resolve must FAIL
 * these tests rather than skip them. Returning early instead ran zero assertions and reported green
 * over the boot path every user hits.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} did not resolve — this suite cannot prove anything without it`);
  }
  return value;
}

let resolveConfig: ResolveConfig | undefined;
let createServer: CreateServer | undefined;

/**
 * Generous, explicit, and NOT a retuned guess.
 *
 * These hooks import Vite and start/stop a real dev server. Measured on an idle machine:
 * `import('vite')` 127ms, createServer+listen 9-55ms, close 0-40ms — including after a keep-alive
 * fetch, which was the first thing suspected and is not the cause. So the work is ~0.2s and vitest's
 * default 10s hook timeout has two orders of magnitude of headroom. It still fails, on Windows CI
 * and on a Mac deep into swap, because a machine that is thrashing is slow by a factor that makes
 * any fixed number wrong.
 *
 * Raising this is NOT the mistake corrected in tool-fuzz. There, the timeout WAS the assertion — it
 * defined what counted as "hung", so bumping it changed what the test claimed. Here the assertion is
 * `expect(...).toContain('tok_written_later')`, and the hook bound is incidental infrastructure: a
 * larger number cannot make a broken plugin pass. This is exactly the remedy CLAUDE.md prescribes —
 * "use a generous per-test timeout" — rather than a statement about the machine.
 */
const HOOK_TIMEOUT_MS = 60_000;
/** How long a dev server gets to close before teardown stops waiting. See the note in afterEach. */
const CLOSE_BUDGET_MS = 5_000;

beforeAll(async () => {
  try {
    const vite = (await import('vite')) as {
      resolveConfig: ResolveConfig;
      createServer: CreateServer;
    };
    resolveConfig = vite.resolveConfig;
    createServer = vite.createServer;
  } catch (error) {
    // A declared dependency that will not import is a broken workspace, not a condition to skip on.
    // Swallowing it made these tests run zero assertions and report green.
    throw error instanceof Error ? error : new Error('vite did not resolve');
  }
}, HOOK_TIMEOUT_MS);

function names(plugins: readonly { name: string }[]): string[] {
  return plugins.map((p) => p.name);
}

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

describe('reticle() in the real Vite config resolution', () => {
  it(
    'is included in the serve pipeline',
    async () => {
      const resolve = required(resolveConfig, 'vite.resolveConfig');
      const resolved = await resolve(
        { plugins: [reticle()], configFile: false, logLevel: 'silent' },
        'serve',
      );
      expect(names(resolved.plugins)).toContain(RETICLE_VITE_PLUGIN_NAME);
    },
    SERVER_BOOT_BUDGET_MS,
  );

  it(
    'is filtered out of the build pipeline (never ships to production)',
    async () => {
      const resolve = required(resolveConfig, 'vite.resolveConfig');
      const resolved = await resolve(
        { plugins: [reticle()], configFile: false, logLevel: 'silent' },
        'build',
      );
      expect(names(resolved.plugins)).not.toContain(RETICLE_VITE_PLUGIN_NAME);
    },
    SERVER_BOOT_BUDGET_MS,
  );
});

/**
 * The daemon may start AFTER the dev server, and this is the case that broke.
 *
 * `load` reads the pairing token at serve time for exactly that reason, but Vite caches the module
 * it produced and answers every later request from that cache — including after a full page reload.
 * So the app kept receiving the tokenless connect module it was served first, the SDK got a 1008
 * `authentication failed` and (correctly) stopped retrying, and `reticle status` reported no session
 * while the page demonstrably contained `/@reticle-connect`. Only restarting the dev server cleared
 * it. Reported from a Windows Vite + React app; reproduces on every platform.
 *
 * Against a REAL dev server, because the whole defect lives in Vite's cache: a unit test on `load`
 * calls it directly and passes either way, which is why nothing here caught this.
 */
describe('the connect module picks up a token written after the dev server started', () => {
  const dirs: string[] = [];
  const servers: DevServerLike[] = [];

  afterEach(async () => {
    // One server that will not close must not strand the others, nor the temp dirs. Teardown that
    // aborts halfway leaks a listening port into the next test, which then fails for a reason that
    // has nothing to do with it — the failure being debugged here, one layer down.
    for (const server of servers.splice(0)) {
      // Bounded, because `close()` can genuinely never resolve. It is an UPSTREAM Vite bug and
      // nothing to do with this plugin: once the dev server has served any PRE-BUNDLED dependency,
      // `close()` never settles. Re-measured on Vite 8.2.0 with no Reticle plugin loaded at all and
      // a plain crawlable entry importing `react`, which hangs identically.
      //
      // Worth stating precisely, because the first reading of this blamed `/@reticle-connect` and
      // guessed the opposite mechanism — that a virtual module triggers dep discovery which never
      // settles. It hangs exactly when discovery HAS settled and the dep is being served from
      // `/.vite/deps/`. Serving the same module with the SDK unbundled closes in 2ms.
      //
      // So this bound is not papering over a defect of ours, and it cannot be removed by fixing one.
      //
      // The assertion this suite exists for has already run by the time teardown starts, so a
      // teardown that cannot finish must not be allowed to fail it — that inversion is what made
      // this look like a flaky timeout for weeks.
      await Promise.race([
        server.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS)),
      ]);
    }
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows holds handles open behind a file watcher; a leaked temp dir is not a test failure */
      }
    }
    delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  }, HOOK_TIMEOUT_MS);

  it(
    'serves the token on the next request, without a dev-server restart',
    async () => {
      const create = required(createServer, 'vite.createServer');
      const tokenDir = mkdtempSync(join(tmpdir(), 'reticle-token-'));
      const root = mkdtempSync(join(tmpdir(), 'reticle-app-'));
      dirs.push(tokenDir, root);
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = tokenDir;

      // A stand-in for the SDK: the import must RESOLVE, or Vite fails the module and re-runs `load`
      // on every request — which hides the staleness the same way it hid it during investigation.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/sdk.js'),
        'export const reticle = { connect(){} };\nexport const install = () => {};\n',
      );
      writeFileSync(
        join(root, 'index.html'),
        '<html><body><script type="module" src="/src/main.js"></script></body></html>',
      );
      writeFileSync(join(root, 'src/main.js'), 'export const app = 1;\n');

      const server = await create({
        root,
        logLevel: 'silent',
        configFile: false,
        server: { port: 0, host: '127.0.0.1' },
        resolve: { alias: { '@reticlehq/react': join(root, 'src/sdk.js') } },
        plugins: [reticle()],
      });
      servers.push(server);
      await server.listen();
      const base = server.resolvedUrls?.local[0] ?? '';
      const url = `${base.replace(/\/$/, '')}${RETICLE_CONNECT_MODULE}`;

      // Served BEFORE the daemon exists: no token, and nothing wrong with that.
      expect(await (await fetch(url)).text()).not.toContain('tok_');

      // The daemon starts and writes its pairing token. The page is reloaded — one more request.
      writeFileSync(join(tokenDir, ReticleDir.PAIRING_TOKEN_FILE), 'tok_written_later');

      expect(await (await fetch(url)).text()).toContain('tok_written_later');
    },
    SERVER_BOOT_BUDGET_MS,
  );
});

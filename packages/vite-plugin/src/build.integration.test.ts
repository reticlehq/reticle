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

let resolveConfig: ResolveConfig | undefined;
let createServer: CreateServer | undefined;

beforeAll(async () => {
  try {
    const vite = (await import('vite')) as {
      resolveConfig: ResolveConfig;
      createServer: CreateServer;
    };
    resolveConfig = vite.resolveConfig;
    createServer = vite.createServer;
  } catch {
    resolveConfig = undefined;
    createServer = undefined;
  }
});

function names(plugins: readonly { name: string }[]): string[] {
  return plugins.map((p) => p.name);
}

describe('reticle() in the real Vite config resolution', () => {
  it('is included in the serve pipeline', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [reticle()], configFile: false, logLevel: 'silent' },
      'serve',
    );
    expect(names(resolved.plugins)).toContain(RETICLE_VITE_PLUGIN_NAME);
  });

  it('is filtered out of the build pipeline (never ships to production)', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [reticle()], configFile: false, logLevel: 'silent' },
      'build',
    );
    expect(names(resolved.plugins)).not.toContain(RETICLE_VITE_PLUGIN_NAME);
  });
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
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  });

  it('serves the token on the next request, without a dev-server restart', async () => {
    if (createServer === undefined) return;
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

    const server = await createServer({
      root,
      logLevel: 'silent',
      configFile: false,
      server: { port: 0 },
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
  });
});

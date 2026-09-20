import { removeTempDir } from './machine/temp-dir.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleEnv, LOOPBACK_HOST } from '@reticlehq/core';
import { resolveBridgeSecurity, startDaemon, type RunningServer } from './index.js';
import { FakeBrowser, waitUntil } from './portal/bridge/bridge.test-harness.js';

describe('resolveBridgeSecurity', () => {
  const ENV_KEYS = [ReticleEnv.TOKEN, ReticleEnv.HOST, ReticleEnv.ALLOWED_ORIGINS] as const;
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('prefers explicit options over the environment', () => {
    process.env[ReticleEnv.TOKEN] = 'from-env';
    const out = resolveBridgeSecurity({ token: 'from-opts', host: 'localhost' });
    expect(out.token).toBe('from-opts');
    expect(out.host).toBe('localhost');
  });

  it('falls back to the environment, parsing the origin allow-list', () => {
    process.env[ReticleEnv.TOKEN] = 'sek';
    process.env[ReticleEnv.ALLOWED_ORIGINS] = 'http://a.test, http://b.test ,';
    const out = resolveBridgeSecurity({});
    expect(out.token).toBe('sek');
    expect(out.allowedOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('omits keys entirely when neither option nor env is set (so Bridge defaults apply)', () => {
    delete process.env[ReticleEnv.TOKEN];
    delete process.env[ReticleEnv.HOST];
    delete process.env[ReticleEnv.ALLOWED_ORIGINS];
    const out = resolveBridgeSecurity({});
    expect('token' in out).toBe(false);
    expect('host' in out).toBe(false);
    expect('allowedOrigins' in out).toBe(false);
  });
});

describe('startDaemon port collision', () => {
  let server: RunningServer | undefined;
  let root: string | undefined;
  let blocker: http.Server | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (blocker !== undefined) await new Promise<void>((r) => blocker?.close(() => r()));
    blocker = undefined;
    if (root !== undefined) await removeTempDir(join(root, '..'));
    root = undefined;
  });

  it('REJECTS (does not hang) when the port is already in use', async () => {
    // Occupy a port, then ask the daemon to bind the same one. Before the fix this hung forever
    // (the 'error' event had no listener), orphaning the process; now it must reject promptly.
    blocker = http.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker?.listen(0, LOOPBACK_HOST, () => {
        const addr = blocker?.address();
        resolve('object' === typeof addr && addr !== null ? addr.port : 0);
      });
    });
    const dir = await mkdtemp(join(tmpdir(), 'reticle-daemon-collide-'));
    root = join(dir, '.reticle');
    await expect(
      // pairingTokenDir → temp so auto-provisioning never writes to the real ~/.reticle in tests.
      startDaemon({ port, reticleRoot: root, pairingTokenDir: root, now: () => 1_700_000_000_000 }),
    ).rejects.toThrow();
  });
});

/**
 * A daemon that has verified nothing must not leave a directory behind.
 *
 * Reported from the field: `.reticle/` kept reappearing in a backend directory the user had never
 * instrumented. Their agent's MCP registration simply starts the daemon there, and the workspace
 * `.gitignore` was written on the START path — so the directory was created by the act of booting,
 * with no project, no session and no verdict in it. Deleting it fixed nothing: the next boot
 * recreated it, which is what made it feel like a loop.
 *
 * The ignore file still gets written, one layer later, against the root a session's artifacts
 * actually land in — which is also the root that was missing it whenever the daemon's cwd and the
 * project's checkout were different trees.
 */
describe('a daemon that nothing connected to', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir !== undefined) await removeTempDir(dir);
    dir = undefined;
  });

  it('creates no .reticle directory where it was started', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-daemon-untouched-'));
    const root = join(dir, '.reticle');
    server = await startDaemon({
      port: 0,
      reticleRoot: root,
      pairingTokenDir: join(dir, 'token'),
      now: () => 1_700_000_000_000,
    });
    // Startup work is best-effort and async; give it a turn to happen before asserting it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(root)).toBe(false);
  });

  it('writes the workspace ignore once a session actually connects', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-daemon-connected-'));
    const root = join(dir, '.reticle');
    server = await startDaemon({
      port: 0,
      reticleRoot: root,
      pairingTokenDir: join(dir, 'token'),
      token: 'pair-me',
      now: () => 1_700_000_000_000,
    });
    const browser = new FakeBrowser(await server.bridge.ready, 'sess-ignore', false, 'pair-me');
    await browser.open();
    await waitUntil(() => existsSync(join(root, '.gitignore')));
    browser.close();
  });
});

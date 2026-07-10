import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleEnv, LOOPBACK_HOST } from '@reticlehq/core';
import { resolveBridgeSecurity, startDaemon, type RunningServer } from './index.js';

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
    if (root !== undefined) await rm(join(root, '..'), { recursive: true, force: true });
    root = undefined;
  });

  it('REJECTS (does not hang) when the port is already in use', async () => {
    // Occupy a port, then ask the daemon to bind the same one. Before the fix this hung forever
    // (the 'error' event had no listener), orphaning the process; now it must reject promptly.
    blocker = http.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker?.listen(0, LOOPBACK_HOST, () => {
        const addr = blocker?.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
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

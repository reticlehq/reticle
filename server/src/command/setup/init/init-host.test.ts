import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { serverInitHost } from './init-host.js';

/**
 * The daemon half of the `init` seam.
 *
 * `@reticlehq/init` asks its host for a pairing token and inlines whatever it gets into the CDN
 * snippet, which has no build step — so an empty value there is a page that can never authenticate.
 * The scaffolder's own tests prove it asks and inlines; nothing over there can prove the answer is a
 * REAL, minted token, because minting belongs to the bridge. That half is proved here.
 */
const saved = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
afterEach(() => {
  if (saved === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = saved;
});

describe('the init host', () => {
  it('mints a pairing token when the daemon has never written one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-init-host-'));
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = dir;
    const token = serverInitHost().pairingToken();
    expect(token.length).toBeGreaterThan(0);
    // Minted to disk, not invented per call: `init` prints it into a file the user pastes, and the
    // daemon has to accept the same value when it starts later.
    expect(readFileSync(join(dir, ReticleDir.PAIRING_TOKEN_FILE), 'utf8').trim()).toBe(token);
  });

  it('returns the same token on a second call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-init-host-'));
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = dir;
    const host = serverInitHost();
    expect(host.pairingToken()).toBe(host.pairingToken());
  });

  it('runs a traced stage exactly once and returns its value', () => {
    // The tracer is off by default. A span that swallowed its function, or ran it twice, would run
    // the whole install twice with tracing on and never be noticed with it off.
    let calls = 0;
    const value = serverInitHost().span('init.test', {}, () => {
      calls += 1;
      return 'result';
    });
    expect(calls).toBe(1);
    expect(value).toBe('result');
  });
});

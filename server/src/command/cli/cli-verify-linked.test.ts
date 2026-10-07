import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { buildVerifyDeps } from './cli-verify.js';
import { harnessAvailable, withLinkedCredential } from '@/surface/tools/harness-explore.js';

/**
 * `reticle connect` files the key in `~/.reticle/credentials.json`. The CLI decided whether the
 * Harness was there from the shell's environment alone, so a connected machine that never exported
 * the key was told to run `reticle connect` again.
 */
describe('reticle verify on a connected machine', () => {
  const running = { bridge: { sessions: {} } } as unknown as Parameters<typeof buildVerifyDeps>[0];

  it('carries the stored credential into the deps the drive reads', () => {
    const deps = buildVerifyDeps(running, '/tmp/app/.reticle', () => 0);
    expect(typeof deps.linkedCloud).toBe('function');
  });

  it('offers the Harness when the only key is the one connect stored', async () => {
    const deps = {
      ...buildVerifyDeps(running, '/tmp/app/.reticle', () => 0),
      linkedCloud: () => Promise.resolve({ url: 'https://app.test', apiKey: 'rk_live_x' }),
    };
    expect(harnessAvailable({})).toBe(false);
    const env = await withLinkedCredential(deps, {});
    expect(env[ReticleEnv.API_KEY]).toBe('rk_live_x');
    expect(harnessAvailable(env)).toBe(true);
  });
});

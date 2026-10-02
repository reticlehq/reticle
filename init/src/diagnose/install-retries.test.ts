import { describe, expect, it } from 'vitest';
import { PackageManager } from '@/detect/detect.js';
import { installRetries } from './install-retries.js';

/**
 * A retry has to spawn the SAME resolved invocation the first attempt did.
 *
 * Reported from the field (#1149): on a corepack-only machine (no bare `pnpm` on PATH, only
 * `corepack pnpm`), the first install attempt correctly spawned `corepack pnpm`, but a retry rung —
 * reached only when that first attempt fails — spawned the bare `pnpm` again and hit the exact
 * ENOENT preflight had already worked around, on the one machine shape a retry exists to rescue.
 */
describe('installRetries threads the resolved invocation through every rung', () => {
  it('spawns corepack, not bare pnpm, when packageManagerCommand is corepack pnpm', () => {
    const retries = installRetries(
      PackageManager.PNPM,
      ['@reticlehq/react'],
      ['@reticlehq/react'],
      '1.2.3',
      'corepack pnpm',
    );
    expect(retries.length).toBeGreaterThan(0);
    for (const retry of retries) {
      expect(retry.command).toBe('corepack');
      expect(retry.args[0]).toBe('pnpm');
    }
  });

  it('spawns the bare binary when nothing else is resolved (default behavior)', () => {
    const retries = installRetries(
      PackageManager.NPM,
      ['@reticlehq/react'],
      ['@reticlehq/react'],
      '1.2.3',
    );
    expect(retries.length).toBeGreaterThan(0);
    for (const retry of retries) {
      expect(retry.command).toBe('npm');
    }
  });
});

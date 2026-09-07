import { describe, expect, it } from 'vitest';
import { PackageManager } from './detect.js';
import {
  LEGACY_PEER_DEPS_FLAG,
  npmLegacyPeerDepsRetry,
  npmrcWantsLegacyPeerDeps,
  withLegacyPeerDeps,
} from './legacy-peer-deps.js';

describe('npmrcWantsLegacyPeerDeps', () => {
  it('reads the project .npmrc', () => {
    expect(npmrcWantsLegacyPeerDeps(['legacy-peer-deps=true\n'])).toBe(true);
  });

  it('accepts a parent .npmrc when the app itself has none', () => {
    expect(npmrcWantsLegacyPeerDeps([null, 'legacy-peer-deps = 1\n'])).toBe(true);
  });

  it('ignores a commented line and an explicit false', () => {
    expect(npmrcWantsLegacyPeerDeps(['# legacy-peer-deps=true\n'])).toBe(false);
    expect(npmrcWantsLegacyPeerDeps(['legacy-peer-deps=false\n'])).toBe(false);
  });

  it('is false when nothing was read', () => {
    expect(npmrcWantsLegacyPeerDeps([null, undefined])).toBe(false);
  });
});

describe('npmLegacyPeerDepsRetry', () => {
  const args = ['i', '-D', '@reticlehq/react', '--no-audit', '--no-fund'];

  it('adds the flag to a failed npm install', () => {
    const retry = npmLegacyPeerDepsRetry({ command: PackageManager.NPM, args });
    expect(retry?.args).toContain(LEGACY_PEER_DEPS_FLAG);
    expect(retry?.args).toContain('@reticlehq/react');
  });

  it('does not retry when the first command already passed the flag', () => {
    expect(
      npmLegacyPeerDepsRetry({
        command: PackageManager.NPM,
        args: withLegacyPeerDeps(args),
      }),
    ).toBeUndefined();
  });

  it('does not invent an npm flag for pnpm', () => {
    expect(
      npmLegacyPeerDepsRetry({
        command: PackageManager.PNPM,
        args: ['add', '-D', '@reticlehq/react'],
      }),
    ).toBeUndefined();
  });
});

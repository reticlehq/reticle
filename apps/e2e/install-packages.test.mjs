import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packageDigest,
  publishablePackages,
  validatePackageManifest,
} from './install-packages.mjs';

it.skipIf(process.platform === 'win32')(
  'keeps package paths relative through a symlinked checkout',
  () => {
    const scratch = mkdtempSync(join(tmpdir(), 'reticle-package-paths-'));
    const root = join(scratch, 'checkout');
    const linked = join(scratch, 'linked');
    try {
      mkdirSync(join(root, 'core'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - core\n');
      writeFileSync(
        join(root, 'core/package.json'),
        JSON.stringify({ name: '@fixture/core', version: '1.0.0' }),
      );
      symlinkSync(root, linked, 'dir');
      expect(publishablePackages(linked)).toEqual([
        {
          name: '@fixture/core',
          version: '1.0.0',
          path: 'core',
          filename: 'fixture-core-1.0.0.tgz',
        },
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

describe('the install matrix consumes only complete artifacts from its own commit', () => {
  const expected = [
    { name: '@reticlehq/core', version: '3.3.0', path: 'core', filename: 'core.tgz' },
  ];
  const bytes = Buffer.from('built package');
  const good = () => ({
    sha: 'current',
    packages: [{ ...expected[0], sha256: packageDigest(bytes) }],
  });
  const validate = (manifest, read = () => bytes) =>
    validatePackageManifest(manifest, expected, 'current', read);
  it('accepts the complete artifact', () => expect(() => validate(good())).not.toThrow());
  it('rejects another commit even when versions match', () => {
    expect(() => validate({ ...good(), sha: 'previous' })).toThrow(/different commit/);
  });
  it('rejects missing, duplicate, and unknown packages', () => {
    expect(() => validate({ ...good(), packages: [] })).toThrow();
    expect(() =>
      validate({ ...good(), packages: [...good().packages, ...good().packages] }),
    ).toThrow();
    expect(() =>
      validate({ ...good(), packages: [{ ...good().packages[0], name: 'other' }] }),
    ).toThrow();
  });
  it.each(['version', 'path', 'filename'])('rejects a changed %s', (key) => {
    const manifest = good();
    manifest.packages[0][key] = '../wrong';
    expect(() => validate(manifest)).toThrow();
  });
  it('rejects corrupted tarballs', () => {
    expect(() => validate(good(), () => Buffer.from('stale package'))).toThrow(/digest/);
  });
});

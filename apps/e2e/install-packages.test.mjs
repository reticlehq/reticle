import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packageDigest,
  publishablePackages,
  restoreInstallPackages,
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

it('restores packed builds, removes stale emitted files, and preserves checkout sources', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'reticle-package-restore-'));
  const root = join(scratch, 'checkout');
  const artifacts = join(scratch, 'artifacts');
  const packed = join(scratch, 'packed');
  try {
    mkdirSync(join(root, 'core/dist'), { recursive: true });
    mkdirSync(artifacts);
    mkdirSync(join(packed, 'package/dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - core\n');
    writeFileSync(join(root, 'core/package.json'), JSON.stringify({ name: '@fixture/core', version: '1.0.0' }));
    writeFileSync(join(root, 'core/source.js'), 'checkout source');
    writeFileSync(join(root, 'core/dist/stale.js'), 'stale build');
    writeFileSync(join(packed, 'package/dist/index.js'), 'packed build');
    writeFileSync(join(packed, 'package/source.js'), 'packed source');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const packages = publishablePackages(root);
    const archive = execFileSync('tar', ['-czf', '-', 'package'], { cwd: packed });
    writeFileSync(join(artifacts, packages[0].filename), archive);
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({
      sha, packages: [{ ...packages[0], sha256: packageDigest(archive) }],
    }));
    expect(restoreInstallPackages(artifacts, root)).toEqual([join(artifacts, packages[0].filename)]);
    expect(readFileSync(join(root, 'core/dist/index.js'), 'utf8')).toBe('packed build');
    expect(existsSync(join(root, 'core/dist/stale.js'))).toBe(false);
    expect(readFileSync(join(root, 'core/source.js'), 'utf8')).toBe('checkout source');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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

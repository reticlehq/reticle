import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function pnpm(args, options = {}) {
  // npm_execpath is set by pnpm scripts. Direct node invocations fall back to the installed CLI.
  if (/(?:^|[/\\])pnpm\.(?:cjs|js)$/.test(process.env.npm_execpath ?? '')) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  const win = process.platform === 'win32';
  return execFileSync(
    win ? 'pnpm.cmd' : 'pnpm',
    win ? args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`) : args,
    { ...options, shell: win },
  );
}

export function publishablePackages(root) {
  return JSON.parse(
    pnpm(['-r', 'list', '--depth', '-1', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  ).flatMap((entry) => {
    const manifest = JSON.parse(readFileSync(join(entry.path, 'package.json'), 'utf8'));
    if (manifest.private) return [];
    return [
      {
        name: manifest.name,
        version: manifest.version,
        path: relative(realpathSync(root), realpathSync(entry.path)).split('\\').join('/'),
        filename: `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
      },
    ];
  });
}

export const packageDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Refuse a stale, incomplete, or corrupted artifact before using any of its builds. */
export function validatePackageManifest(manifest, expected, sha, readTarball) {
  assert.equal(manifest.sha, sha, 'install packages belong to a different commit');
  assert(expected.length > 0, 'no publishable packages');
  assert.equal(manifest.packages?.length, expected.length, 'incomplete install package artifact');
  for (const pkg of expected) {
    const matches = manifest.packages.filter((row) => row.name === pkg.name);
    assert.equal(matches.length, 1, `missing or duplicate package: ${pkg.name}`);
    const row = matches[0];
    for (const key of ['version', 'path', 'filename'])
      assert.equal(row[key], pkg[key], `${pkg.name}: ${key}`);
    assert.equal(
      row.sha256,
      packageDigest(readTarball(pkg.filename)),
      `${pkg.name}: tarball digest`,
    );
  }
}

export function restoreInstallPackages(directory, root) {
  const expected = publishablePackages(root);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  validatePackageManifest(manifest, expected, sha, (file) => readFileSync(join(directory, file)));
  const tarballs = [];
  for (const pkg of expected) {
    const tarball = resolve(directory, pkg.filename);
    // GNU tar treats the colon in a Windows drive path as a remote archive. Stdin keeps the
    // verified bytes local regardless of which tar the runner puts on PATH.
    const archive = readFileSync(tarball);
    const listing = execFileSync('tar', ['-tzf', '-'], {
      input: archive,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const members = listing.trim().split(/\r?\n/);
    assert(
      members.every((member) => member.startsWith('package/') && !member.split('/').includes('..')),
      `unsafe archive: ${pkg.name}`,
    );
    // Restore only emitted code; sources/configs remain this checkout's. Packages such as Next
    // ship source .cjs files and need no dist. Removing dist prevents stale files masking omissions.
    const target = join(root, pkg.path);
    rmSync(join(target, 'dist'), { recursive: true, force: true });
    if (members.some((member) => member.startsWith('package/dist/'))) {
      const selection = mkdtempSync(join(tmpdir(), 'reticle-tar-members-'));
      try {
        const list = join(selection, 'members');
        writeFileSync(
          list,
          // Selecting a directory recursively consumes its files. Listing those files again
          // makes GNU tar seek backwards in the stdin archive and report them as missing.
          members.filter((member) => member.startsWith('package/dist/') && !member.endsWith('/')).join('\n') + '\n',
        );
        execFileSync('tar', ['-xzf', '-', '--strip-components=1', '-T', list], {
          cwd: target,
          input: archive,
        });
      } finally {
        rmSync(selection, { recursive: true, force: true });
      }
    }
    tarballs.push(tarball);
  }
  assert.equal(
    readdirSync(directory).filter((file) => file.endsWith('.tgz')).length,
    expected.length,
    'unexpected tarballs in artifact',
  );
  return tarballs;
}

#!/usr/bin/env node
/**
 * Refuse a publish that would skip a package whose dependencies changed under an unchanged version.
 *
 * `pnpm -r publish` skips any version already on npm. That is what makes a failed publish safe to
 * re-run, and it is also how 3.8.1 shipped broken: `open-verification` moved from zod 3 to zod 4 but
 * stayed at 1.0.0 (it is not lockstepped), so the publish skipped it, `@reticlehq/core@3.8.1` pinned
 * the zod 3 build already on npm, and every run that core parsed threw "Invalid element at key
 * \"subject\": expected a Zod schema". Nothing failed until a user ran it.
 *
 * For every public workspace package whose version is already on npm, the dependencies npm has must
 * be the ones this tree would publish. A difference means the content changed and the version did
 * not: bump it. `workspace:*` is read as the version the workspace package carries, since that is
 * what pnpm writes at pack time.
 *
 * Dependencies are not enough. 3.10.3 changed the FILES of `open-verification` (a zod-free module
 * and `sideEffects: false`) and none of its dependencies, so this check passed, the publish skipped
 * the package, and `@reticlehq/core@3.10.3` pinned the old build: every page that installed the SDK
 * from npm loaded zod again. So the packed files are compared too: this tree's `pnpm pack` against
 * the tarball npm serves, file by file (`contentDifferences`).
 *
 * usage: node scripts/check-unbumped-packages.mjs        (exit 1 and a list when any differ)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Every non-private workspace package, by name, with its directory and manifest. */
const workspacePackages = () => {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: ROOT, encoding: 'utf8' }),
  );
  const out = new Map();
  for (const { path } of listed) {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (true !== manifest.private && 'string' === typeof manifest.name) {
      out.set(manifest.name, { ...manifest, dir: path });
    }
  }
  return out;
};

/** The dependency map pnpm would publish: `workspace:` ranges become the sibling's version. */
export const publishedDependencies = (manifest, siblings) =>
  Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, range]) => {
      if (!String(range).startsWith('workspace:')) {
        return [name, range];
      }
      const sibling = siblings.get(name);
      return [name, undefined === sibling ? range : sibling.version];
    }),
  );

/** The differences between two dependency maps, as `name: npm → local` lines. */
export const differences = (onNpm, local) => {
  const names = [...new Set([...Object.keys(onNpm ?? {}), ...Object.keys(local)])].sort();
  return names
    .filter((name) => (onNpm ?? {})[name] !== local[name])
    .map(
      (name) =>
        `${name}: ${String((onNpm ?? {})[name] ?? '(none)')} → ${String(local[name] ?? '(none)')}`,
    );
};

/** Every file below `dir`, as paths relative to it with `/` separators, sorted. */
const filesBelow = (dir) => {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        out.push(relative(dir, path).split('\\').join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
};

const MANIFEST_FILE = 'package.json';

/** A file's content as a comparable string: package.json as parsed data, every other file by hash. */
const fingerprint = (path, file) => {
  const bytes = readFileSync(path);
  if (MANIFEST_FILE === file) {
    const sortKeys = (value) =>
      null !== value && 'object' === typeof value && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sortKeys(value[key])]),
          )
        : value;
    return JSON.stringify(sortKeys(JSON.parse(bytes.toString('utf8'))));
  }
  return createHash('sha256').update(bytes).digest('hex');
};

/**
 * The differences between two unpacked packages: the one npm serves and the one this tree packs.
 * Each line names a file and says how it differs. `package.json` is read as data, so key order and
 * spacing are not a change.
 */
export const contentDifferences = (npmDir, localDir) => {
  const onNpm = new Set(filesBelow(npmDir));
  const here = new Set(filesBelow(localDir));
  const lines = [];
  for (const file of [...new Set([...onNpm, ...here])].sort()) {
    if (!onNpm.has(file)) {
      lines.push(`${file}: only in this tree`);
    } else if (!here.has(file)) {
      lines.push(`${file}: only on npm`);
    } else if (fingerprint(join(npmDir, file), file) !== fingerprint(join(localDir, file), file)) {
      lines.push(`${file}: changed`);
    }
  }
  return lines;
};

/** Pack `name@version` from npm and this tree's copy from `dir`, unpack both, and compare them. */
const packedDifferences = (name, version, dir) => {
  const work = mkdtempSync(join(tmpdir(), 'reticle-unbumped-'));
  try {
    const unpack = (tarball, into) => {
      mkdirSync(into, { recursive: true });
      execFileSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'ignore' });
      return join(into, 'package');
    };
    const tarballIn = (folder) =>
      join(folder, readdirSync(folder).find((file) => file.endsWith('.tgz')) ?? '');
    const npmPack = join(work, 'npm');
    const localPack = join(work, 'local');
    mkdirSync(npmPack);
    mkdirSync(localPack);
    execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', npmPack], {
      stdio: 'ignore',
    });
    execFileSync('pnpm', ['pack', '--pack-destination', localPack], { cwd: dir, stdio: 'ignore' });
    return contentDifferences(
      unpack(tarballIn(npmPack), join(work, 'npm-files')),
      unpack(tarballIn(localPack), join(work, 'local-files')),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const npmManifest = (name, version) => {
  try {
    return JSON.parse(
      execFileSync('npm', ['view', `${name}@${version}`, 'dependencies', 'version', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null; // not on npm yet: this publish will ship it, nothing to compare
  }
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const siblings = workspacePackages();
  const stale = [];
  for (const [name, manifest] of siblings) {
    const onNpm = npmManifest(name, manifest.version);
    if (null === onNpm) {
      continue;
    }
    const diff = differences(onNpm.dependencies, publishedDependencies(manifest, siblings));
    if (0 < diff.length) {
      stale.push(
        `${name}@${manifest.version} is on npm with other dependencies:\n  ${diff.join('\n  ')}`,
      );
      continue;
    }
    const files = packedDifferences(name, manifest.version, manifest.dir);
    if (0 < files.length) {
      stale.push(
        `${name}@${manifest.version} is on npm with other files:\n  ${files.join('\n  ')}`,
      );
    }
  }
  if (0 < stale.length) {
    console.error(
      `check-unbumped-packages: these would be skipped by the publish while their content changed. Bump their versions.\n${stale.join('\n')}`,
    );
    process.exit(1);
  }
  console.log(
    `check-unbumped-packages: ${String(siblings.size)} public packages, none changed under a published version`,
  );
}

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * A published package imports only what it declares.
 *
 * The incident: a published `@reticlehq/engine` shipped `import { MeasureOp } from 'open-verification'`
 * in `dist/question/predicate/property.js` while declaring `open-verification` only as a
 * devDependency. It resolved in the monorepo, and in a plain npm install only because core's own
 * dependency happened to hoist it; a pnpm-strict or Yarn PnP install fails on the first predicate.
 * Every gate passed, because every gate runs inside the workspace where the package is linked.
 *
 * So this reads each published package's shipped source (no tests) for import and export
 * statements that start a line, and requires the bare specifier to be a declared dependency,
 * peer, or optional dependency. Code a package WRITES as text (init's generated connect files)
 * also starts lines with `import`, so those packages are listed below with the reason.
 */

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/** Bare specifiers that appear in shipped source as TEXT a package writes, not as its imports. */
const GENERATED_TEXT: Readonly<Record<string, readonly string[]>> = {
  // `init` writes connect files INTO the user's project; these are the imports of that code, held
  // as template text in patch/snippets.ts, and the user's app is what declares them.
  '@reticlehq/init': [
    '@reticlehq/vite-plugin',
    '@reticlehq/next',
    '@reticlehq/react',
    'react',
    'react-dom',
  ],
};

const BUILTINS = new Set(builtinModules);
const STATEMENT =
  /^\s*(?:import|export)\b[^'"`]*?\bfrom\s+['"]([^'"./@][^'"]*|@[^/'"]+\/[^'"]+)['"]/gm;
const SIDE_EFFECT = /^\s*import\s+['"]([^'"./@][^'"]*|@[^/'"]+\/[^'"]+)['"]/gm;

function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : (parts[0] ?? '');
}

function publishable(): { dir: string; manifest: Manifest }[] {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: 'win32' === process.platform,
    }),
  ) as { name?: string; path?: string; private?: boolean }[];
  return listed
    .filter((p) => undefined !== p.name && undefined !== p.path && true !== p.private)
    .map((p) => ({
      dir: p.path ?? '',
      manifest: JSON.parse(readFileSync(join(p.path ?? '', 'package.json'), 'utf8')) as Manifest,
    }));
}

function shippedSources(dir: string): string[] {
  const rel = relative(REPO_ROOT, dir);
  return execFileSync('git', ['ls-files', '--', `${rel}/src`], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.test\.|\.d\.ts$|\/test\//.test(f));
}

describe('published packages import only what they declare', () => {
  const packages = publishable();

  it('finds the packages and their source at all', () => {
    expect(packages.length).toBeGreaterThan(8);
    expect(packages.some((p) => shippedSources(p.dir).length > 0)).toBe(true);
  });

  it.each(packages.map((p) => [p.manifest.name ?? p.dir, p] as const))(
    '%s declares every package its shipped source imports',
    (_name, { dir, manifest }) => {
      const declared = new Set([
        manifest.name ?? '',
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...(GENERATED_TEXT[manifest.name ?? ''] ?? []),
      ]);
      const undeclared = new Set<string>();
      for (const file of shippedSources(dir)) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8');
        for (const re of [STATEMENT, SIDE_EFFECT]) {
          for (const m of text.matchAll(re)) {
            const specifier = m[1] ?? '';
            // A template placeholder or prose is not a module specifier.
            if (/[\s$]/.test(specifier)) continue;
            const pkg = packageOf(specifier);
            if (BUILTINS.has(pkg) || pkg.startsWith('node:') || declared.has(pkg)) continue;
            undeclared.add(`${pkg} (${file})`);
          }
        }
      }
      expect([...undeclared]).toEqual([]);
    },
  );
});

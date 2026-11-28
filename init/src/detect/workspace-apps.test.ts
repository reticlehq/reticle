/**
 * A monorepo whose apps are NOT under `apps/` was invisible, and init reported success anyway.
 *
 * Measured on a real repo: three Next apps at `web/`, `admin/`, `space/`, each with next.config.js
 * and app/layout.tsx, nothing at the root. `findWorkspaceApps` only ever looked in `apps/` and
 * `packages/`, so it found none, the redirect did not fire, and init ran against the ROOT — warning
 * about a `next.config.mjs` that exists nowhere and reporting ✓ for writing `app/reticle-dev.tsx`
 * into the repo root, which Next never compiles.
 *
 * A ⚠ tells a human to act. A ✓ tells them it is handled. This produced the second for a file that
 * does nothing.
 *
 * The fix is to stop guessing directory names. A workspace DECLARES its packages — `workspaces` in
 * package.json, `packages:` in pnpm-workspace.yaml — and that declaration is authoritative. Where
 * there is none, the top-level directories are a better guess than two hardcoded names.
 */

import { describe, expect, it } from 'vitest';
import { findAppsBelow, findWorkspaceApps, isWebApp, workspaceParents } from './workspace-apps.js';
import { memoryIo } from '../memory-io.test-helpers.js';

describe('where a workspace keeps its packages', () => {
  it('reads pnpm-workspace.yaml, which is the authoritative answer', () => {
    const yaml = "packages:\n  - 'web'\n  - 'admin'\n  - 'tools/*'\n";
    expect(workspaceParents({ pnpmWorkspace: yaml })).toEqual(
      expect.arrayContaining(['web', 'admin', 'tools']),
    );
  });

  it('reads the package.json `workspaces` array', () => {
    expect(workspaceParents({ pkgWorkspaces: ['packages/*', 'web'] })).toEqual(
      expect.arrayContaining(['packages', 'web']),
    );
  });

  it('reads the yarn/npm object form too', () => {
    expect(workspaceParents({ pkgWorkspaces: { packages: ['apps/*'] } })).toContain('apps');
  });

  it('falls back to the top-level directories when nothing is declared', () => {
    // Three Next apps at the root with no workspace file is a real shape, and hardcoding
    // apps/packages misses every one of them.
    expect(
      workspaceParents({ topLevelDirs: ['web', 'admin', 'space', 'node_modules', '.git'] }),
    ).toEqual(expect.arrayContaining(['web', 'admin', 'space']));
  });

  it('never scans node_modules, dot-directories, or build output', () => {
    const parents = workspaceParents({
      topLevelDirs: ['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'web'],
    });
    expect(parents).toEqual(['web']);
  });

  it('survives a malformed workspace file rather than throwing', () => {
    expect(() => workspaceParents({ pnpmWorkspace: 'packages: [unclosed' })).not.toThrow();
    expect(() => workspaceParents({ pkgWorkspaces: 42 })).not.toThrow();
  });

  it('deduplicates, so a directory named in both places is scanned once', () => {
    const parents = workspaceParents({
      pkgWorkspaces: ['apps/*'],
      topLevelDirs: ['apps', 'web'],
    });
    expect(parents.filter((p) => 'apps' === p)).toHaveLength(1);
  });
});

/**
 * A workspace app is one somebody can SERVE.
 *
 * `looksLikeApp` asked only for a bundler: a vite/next config file, or one of those two in the
 * dependencies. That misses every app built on anything else — Remix, Astro, a plain node server,
 * a Rails-style app with a JS front end — and in a monorepo missing it means init never redirects,
 * wires the ROOT, and reports ✓ for files nothing compiles.
 *
 * A dev script alone can start an API, library watcher or web server. A separate web-page
 * signal is required so init does not silently instrument a tool package.
 */
describe('an app is a directory that can be served', () => {
  const repo = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    readFile: (p: string) => files[p] ?? null,
    listDirs: (p: string) => ('apps' === p ? ['docs', 'web'] : []),
  });

  it('finds a web app with a dev script and its own page', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        // NOT `dev: 'vite'` — the dependency check is a substring match on the raw manifest, so that
        // string would make this pass without the dev-script signal existing at all.
        'apps/web/package.json': JSON.stringify({
          name: 'web',
          scripts: { dev: 'node server.js' },
        }),
        'apps/web/index.html': '<main>Web app</main>',
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });

  // The whole point of the filter: a package that cannot be served is not the app.
  it('skips a workspace package with only a build script', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        'apps/docs/package.json': JSON.stringify({ name: 'docs', scripts: { build: 'true' } }),
        'apps/web/package.json': JSON.stringify({
          name: 'web',
          scripts: { dev: 'node server.js' },
        }),
        'apps/web/index.html': '<main>Web app</main>',
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });

  it('accepts start and serve as well as dev', () => {
    for (const script of ['start', 'serve'] as const) {
      const apps = findWorkspaceApps(
        repo({
          'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
          'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { [script]: 'node .' } }),
          'apps/web/index.html': '<main>Web app</main>',
        }),
      );
      expect(apps).toEqual(['apps/web']);
    }
  });

  // Config identifies the build tool; the page proves what the build serves.
  it('still finds a web app with a bundler config and its own page', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        'apps/web/package.json': JSON.stringify({ name: 'web' }),
        'apps/web/vite.config.ts': 'x',
        'apps/web/index.html': '<main>Web app</main>',
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });

  // Vite+ (#2134): `vite-plus` is the bundler, and a pnpm app may not declare `vite` at all. Read as
  // a backend, the app was left out when a backend sat beside it.
  it('counts a package that declares only vite-plus as an app with a page', () => {
    const files: Record<string, string> = {
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        devDependencies: { 'vite-plus': '1.5.0' },
        scripts: { dev: 'vp dev' },
      }),
      'apps/web/index.html': '<main>Vite+ app</main>',
    };
    const io = { exists: (p: string) => p in files, readFile: (p: string) => files[p] ?? null };
    expect(isWebApp('apps/web', io)).toBe(true);
  });
});

describe('web app selection must not treat build tooling as a page', () => {
  it('does not consider a Vite library a web app just because it has a config and dev script', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'backend', workspaces: ['tools/*'] }),
      'tools/builder/package.json': JSON.stringify({
        name: 'internal-builder',
        scripts: { dev: 'vite build --watch', build: 'vite build' },
        devDependencies: { vite: '^8' },
      }),
      'tools/builder/vite.config.ts': 'export default { build: { lib: {} } };',
      'tools/builder/src/index.ts': 'export const helper = true;',
    });
    expect(isWebApp('tools/builder', io)).toBe(false);
    expect(findWorkspaceApps(io)).toEqual([]);
    expect(findAppsBelow(io)).toEqual([]);
  });

  it('keeps the legacy server-rendered fallback without calling it a web UI', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'backend', workspaces: ['tools/*'] }),
      'tools/api/package.json': JSON.stringify({
        name: 'api',
        scripts: { dev: 'node server.js' },
        dependencies: { express: '^5' },
      }),
    });
    expect(isWebApp('tools/api', io)).toBe(false);
    // A server-rendered app may have no index.html: keep the historical fallback,
    // but do not let it compete with an actual UI elsewhere in the workspace.
    expect(findWorkspaceApps(io)).toEqual(['tools/api']);
    expect(findAppsBelow(io)).toEqual([]);
  });

  it('selects a real Vite web app over a sibling library or backend', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }),
      'apps/library/package.json': JSON.stringify({
        name: 'library',
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8' },
      }),
      'apps/library/vite.config.ts': 'export default { build: { lib: {} } };',
      'apps/backend/package.json': JSON.stringify({
        scripts: { dev: 'node server.js' },
        dependencies: { express: '^5' },
      }),
      'apps/web/package.json': JSON.stringify({
        scripts: { dev: 'vite' },
        devDependencies: { vite: '^8' },
      }),
      'apps/web/index.html': '<div id="app"></div>',
      'apps/web/vite.config.ts': 'export default {}',
    });
    expect(findWorkspaceApps(io)).toEqual(['apps/web']);
  });

  it('keeps framework-rendered apps without a root index.html discoverable', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }),
      'apps/dashboard/package.json': JSON.stringify({
        scripts: { dev: 'next dev' },
        dependencies: { next: '^16', react: '^19' },
      }),
    });
    expect(findWorkspaceApps(io)).toEqual(['apps/dashboard']);
  });
});

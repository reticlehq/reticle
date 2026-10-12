/**
 * `init` run where the app is not: the commonest reason it fails at all.
 *
 * `no_package_json` is the top `init` failure in the field, and the case behind it is a person (or
 * their agent) standing one or more folders above the app: a backend + frontend repo whose web app
 * sits under `client/web`, a home folder, a docs site that is a bare `index.html` in `site/`. The
 * redirect already looked one level down (two for a workspace parent); deeper, or a page with no
 * package.json, ended in "Run `reticle init` from your app's directory" with nothing to run.
 */
import { describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';

const OPTS: InitOptions = {
  cwd: '/project',
  port: undefined,
  mcp: false,
  install: false,
  dryRun: false,
};

const VITE_APP = JSON.stringify({
  name: 'web',
  scripts: { dev: 'vite' },
  dependencies: { react: '^19.0.0' },
  devDependencies: { vite: '^6.0.0' },
});

describe('init finds the app below where it was run', () => {
  it('wires the one app three folders down in a repo with no package.json at its root', () => {
    const io = memoryIo({
      'backend/requirements.txt': 'fastapi\n',
      'client/web/app/package.json': VITE_APP,
      'client/web/app/vite.config.ts': 'export default {}',
      'client/web/app/index.html': '<div id="root"></div>',
    });
    const result = runInit(OPTS, io);
    expect(io.lines.join('\n')).toContain('client/web/app');
    expect(Object.keys(io.written)).toContain('client/web/app/.reticle.json');
    expect(result.ok).toBe(true);
  });

  it('lists several apps it found deeper down, each as a command to paste', () => {
    const io = memoryIo({
      'services/api/main.go': 'package main',
      'clients/web/shop/package.json': VITE_APP,
      'clients/web/shop/vite.config.ts': 'export default {}',
      'clients/web/admin/package.json': VITE_APP,
      'clients/web/admin/vite.config.ts': 'export default {}',
    });
    const outcomes: unknown[] = [];
    const result = runInit(OPTS, {
      ...io,
      host: { ...io.host, reportOutcome: (o) => outcomes.push(o) },
    });
    // Same series as before: a run where there is no app, counted once.
    expect(outcomes).toEqual([{ ok: false, reason: 'no_package_json' }]);
    const out = io.lines.join('\n');
    expect(out).toContain('reticle init --app clients/web/shop');
    expect(out).toContain('reticle init --app clients/web/admin');
    expect(result.ok).toBe(false);
    expect(Object.keys(io.written)).toEqual([]);
  });

  it('wires a plain page in a subfolder, the one app here without a package.json', () => {
    const io = memoryIo({
      'README.md': '# docs',
      'site/index.html': '<!doctype html><html><body><h1>Hi</h1></body></html>',
    });
    runInit(OPTS, io);
    expect(io.lines.join('\n')).toContain('site');
    expect(io.written['site/index.html']).toContain('reticle:connect');
  });

  it('takes --app pointing at a plain page', () => {
    const io = memoryIo({ 'site/index.html': '<!doctype html><html><body></body></html>' });
    runInit({ ...OPTS, app: 'site' }, io);
    expect(io.written['site/index.html']).toContain('reticle:connect');
  });

  it('never wires an app on its own from a home folder: it lists what it found', () => {
    const home = memoryIo({
      'code/shop/package.json': VITE_APP,
      'code/shop/vite.config.ts': 'export default {}',
    });
    const io = { ...home, cwd: () => '/home/u', homeDir: () => '/home/u' };
    const result = runInit({ ...OPTS, cwd: '/home/u' }, io);
    const out = io.lines.join('\n');
    expect(out).toContain('home folder');
    expect(out).toContain('reticle init --app code/shop');
    expect(result.ok).toBe(false);
    expect(Object.keys(io.written)).toEqual([]);
  });

  it('does not walk into dependencies, build output or hidden folders', () => {
    const io = memoryIo({
      'node_modules/some-lib/package.json': VITE_APP,
      'node_modules/some-lib/vite.config.ts': '',
      '.cache/x/y/package.json': VITE_APP,
      '.cache/x/y/vite.config.ts': '',
      'dist/a/b/package.json': VITE_APP,
      'dist/a/b/vite.config.ts': '',
    });
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.cache');
    expect(out).toContain('No package.json found here');
  });
});

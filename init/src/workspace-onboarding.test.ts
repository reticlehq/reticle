/**
 * Monorepos: where `init` runs decided which daemon the agent talked to, and whether it ran at all.
 *
 * Four defects of one shape, each measured on a create-turbo / pnpm / npm-workspaces scaffold:
 *
 * - The root refused whenever a sibling had a `dev` script (#1148) — so every repo with an API
 *   package beside its web app was "ambiguous", though only one of the two has a page to connect.
 * - The refusal's copy-paste hint named `apps[0]`, which in that repo was the backend.
 * - Re-running at the root after a successful `--app` run exited 1 forever: the redirect never read
 *   the root `.reticle.json` that run had written, although it names the app.
 * - `init` run INSIDE `apps/web` wrote its config there only. `reticle mcp` finds `.reticle.json` by
 *   walking UP, so an agent opened at the repo root never found it and fell back to the default
 *   port — somebody else's daemon, silently. The `--app` path writes that root pointer; both paths
 *   now leave the root in the same state.
 */
import { describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';

const ROOT = '/repo';
const OPTS: InitOptions = { cwd: ROOT, port: undefined, mcp: false, install: false, dryRun: false };

const WORKSPACE_ROOT = JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] });
const WEB = {
  'apps/web/package.json': JSON.stringify({
    name: 'web',
    scripts: { dev: 'vite' },
    dependencies: { react: '^19' },
    devDependencies: { vite: '^7' },
  }),
  'apps/web/vite.config.ts': 'export default { plugins: [] };\n',
};
const ADMIN = {
  'apps/admin/package.json': JSON.stringify({
    name: 'admin',
    scripts: { dev: 'next dev' },
    dependencies: { next: '16', react: '^19' },
  }),
};
/** An API package: it has a dev script, and no page anyone could connect. */
const API = {
  'apps/api/package.json': JSON.stringify({
    name: 'api',
    scripts: { dev: 'tsx watch src/index.ts' },
    dependencies: { express: '^5' },
  }),
  'apps/api/src/index.ts': 'export {};\n',
};

describe('a backend beside the app', () => {
  it('is not a candidate, so the root wires the one app there is', () => {
    const io = memoryIo({ 'package.json': WORKSPACE_ROOT, ...WEB, ...API });
    const result = runInit(OPTS, io);
    expect(io.lines.join('\n')).not.toContain('Several apps found');
    expect(io.written['apps/web/vite.config.ts']).toContain('reticle(');
    expect(io.written['apps/api/.reticle.json']).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('is left out of the list, and out of the hint, when the choice is real', () => {
    const io = memoryIo({ 'package.json': WORKSPACE_ROOT, ...WEB, ...ADMIN, ...API });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(false);
    const out = io.lines.join('\n');
    expect(out).toContain('apps/web');
    expect(out).toContain('apps/admin');
    expect(out).not.toContain('apps/api');
  });

  it('still counts a package with a page of its own', () => {
    const io = memoryIo({
      'package.json': WORKSPACE_ROOT,
      ...API,
      'apps/site/package.json': JSON.stringify({ name: 'site', scripts: { dev: 'serve .' } }),
      'apps/site/index.html': '<!doctype html><html><body></body></html>\n',
    });
    runInit(OPTS, io);
    expect(io.lines.join('\n')).toContain('apps/site');
  });
});

describe('re-running at the root after `--app`', () => {
  it('follows the root config to the app it names instead of refusing again', () => {
    const files = { 'package.json': WORKSPACE_ROOT, ...WEB, ...ADMIN };
    const first = memoryIo(files);
    expect(runInit({ ...OPTS, app: 'apps/web' }, first).ok).toBe(true);
    const rootConfig = first.written[`${ROOT}/.reticle.json`];
    expect(rootConfig).toBeDefined();

    // The same checkout, as the second run sees it: the root pointer is `.reticle.json` from here.
    const second = memoryIo({ ...files, ...first.written, '.reticle.json': rootConfig ?? '' });
    const result = runInit(OPTS, second);
    expect(second.lines.join('\n')).not.toContain('Several apps found');
    expect(second.lines.join('\n')).toContain('apps/web');
    expect(result.ok).toBe(true);
  });
});

describe('init run inside the app directory of a workspace', () => {
  const APP_DIR = `${ROOT}/apps/web`;
  const inside = (): ReturnType<typeof memoryIo> =>
    memoryIo({
      [`${ROOT}/package.json`]: WORKSPACE_ROOT,
      'package.json': WEB['apps/web/package.json'],
      'vite.config.ts': WEB['apps/web/vite.config.ts'],
    });

  it('writes the root pointer the `--app` path writes, so an agent at the root finds the app', () => {
    const io = inside();
    runInit({ ...OPTS, cwd: APP_DIR }, io);
    const appConfig = io.written['.reticle.json'];
    expect(appConfig).toBeDefined();
    expect(io.written[`${ROOT}/.reticle.json`]).toBe(appConfig);
  });

  it('leaves the root exactly as `--app` from the root leaves it — agent files included', () => {
    const atRoot = (written: Record<string, string>): string[] =>
      Object.keys(written)
        .filter((p) => p.startsWith(`${ROOT}/`))
        .sort();
    const fromInside = inside();
    runInit({ ...OPTS, mcp: true, cwd: APP_DIR }, fromInside);
    const fromRoot = memoryIo({ 'package.json': WORKSPACE_ROOT, ...WEB });
    runInit({ ...OPTS, mcp: true, app: 'apps/web' }, fromRoot);
    expect(atRoot(fromInside.written)).toContain(`${ROOT}/CLAUDE.md`);
    expect(atRoot(fromInside.written)).toEqual(atRoot(fromRoot.written));
  });

  it('leaves a directory that is not a declared workspace member alone', () => {
    const io = memoryIo({
      [`${ROOT}/package.json`]: JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      'package.json': WEB['apps/web/package.json'],
      'vite.config.ts': WEB['apps/web/vite.config.ts'],
    });
    runInit({ ...OPTS, cwd: APP_DIR }, io);
    expect(io.written[`${ROOT}/.reticle.json`]).toBeUndefined();
  });
});

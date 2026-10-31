import { afterEach, describe, expect, it, vi } from 'vitest';

const { checkForUpdate, exec, refreshAgentRules } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  exec: vi.fn(() => true),
  refreshAgentRules: vi.fn<typeof import('@reticlehq/init').refreshAgentRules>(() => ({
    updated: [],
    unchanged: [],
  })),
}));

vi.mock('@/command/update/update-checker.js', () => ({ checkForUpdate }));
vi.mock('@reticlehq/init', async (importOriginal) => {
  // The real detection and file access, so a workspace's lockfile is read as it is on disk; only the
  // install itself is faked, and it is told which manager was chosen.
  const actual = await importOriginal<typeof import('@reticlehq/init')>();
  return {
    ...actual,
    refreshAgentRules,
    buildNodeIo: (cwd: string, host: Parameters<typeof actual.buildNodeIo>[1]) => ({
      ...actual.buildNodeIo(cwd, host),
      exec,
    }),
    installCommandParts: (pm: string, specs: string[]) => ({ command: pm, args: ['i', ...specs] }),
  };
});

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';
import { handleUpdate } from './cli-update-commands.js';

/** An app whose package.json declares the SDK and whose node_modules holds `installed`. */
function appWithSdk(installed: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-update-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { '@reticlehq/react': installed } }),
  );
  mkdirSync(join(dir, 'node_modules', '@reticlehq', 'react'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@reticlehq', 'react', 'package.json'),
    JSON.stringify({ version: installed }),
  );
  return dir;
}

describe('handleUpdate', () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    process.exitCode = undefined;
    exec.mockClear();
    vi.restoreAllMocks();
  });

  // Reported from the field: the CLI was current, the page still ran an older overlay, and
  // `reticle update` answered "already on the latest version" without touching the app.
  it('brings an older app SDK up to this CLI even when the CLI itself is current', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleUpdate(appWithSdk('0.0.1'));

    expect(exec).toHaveBeenCalledWith('npm', ['i', `@reticlehq/react@${SERVER_VERSION}`]);
    expect(out.mock.calls.flat().join('')).toContain('restart your dev server');
  });

  it('leaves an app SDK alone when it already matches the CLI', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleUpdate(appWithSdk(SERVER_VERSION));

    expect(exec).not.toHaveBeenCalled();
  });

  it('never downgrades an app whose SDK is newer than this CLI', async () => {
    // An old CLI that could not reach the registry reads as "current" and used to pin a newer app
    // back to its own version.
    checkForUpdate.mockResolvedValueOnce({});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleUpdate(appWithSdk('999.0.0'));

    expect(exec).not.toHaveBeenCalled();
  });

  it('leaves an app that links its Reticle packages locally alone', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = appWithSdk('0.0.1');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { '@reticlehq/react': 'workspace:*' } }),
    );

    await handleUpdate(dir);

    expect(exec).not.toHaveBeenCalled();
  });

  // From review: an app inside a pnpm workspace keeps its lockfile at the workspace root, so reading
  // only the app's own folder chose npm and ran `npm i` inside a pnpm workspace.
  it('installs with the package manager of the workspace when its lockfile is at the root', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = mkdtempSync(join(tmpdir(), 'reticle-update-ws-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const app = join(root, 'apps', 'web');
    mkdirSync(join(app, 'node_modules', '@reticlehq', 'react'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'web', devDependencies: { '@reticlehq/react': '0.0.1' } }),
    );
    writeFileSync(
      join(app, 'node_modules', '@reticlehq', 'react', 'package.json'),
      JSON.stringify({ version: '0.0.1' }),
    );

    await handleUpdate(app);

    expect(exec).toHaveBeenCalledWith('pnpm', ['i', `@reticlehq/react@${SERVER_VERSION}`]);
  });

  it('says where to run it when this folder has no Reticle SDK', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleUpdate(mkdtempSync(join(tmpdir(), 'reticle-update-empty-')));

    expect(exec).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('')).toContain("app's folder");
  });

  // #1948: this branch returned "already on the latest version" before the rules refresh, so a
  // project on the latest CLI kept the managed block that its first `init` wrote.
  it('refreshes a stale managed block even when the CLI itself is current', async () => {
    const actual = await vi.importActual<typeof import('@reticlehq/init')>('@reticlehq/init');
    refreshAgentRules.mockImplementationOnce(actual.refreshAgentRules);
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = appWithSdk(SERVER_VERSION);
    const stale = [
      '# My project',
      '',
      'Some notes I wrote myself.',
      '',
      '<!-- reticle:begin (managed by `reticle init` — edit outside these markers) -->',
      '## Verifying with Reticle',
      'An old rule from a previous release.',
      '<!-- reticle:end -->',
      '',
      'More of my own notes, after the block.',
    ].join('\n');
    const unmanaged = '# Agents\n\nNo Reticle block here.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), stale);
    writeFileSync(join(dir, 'AGENTS.md'), unmanaged);

    await handleUpdate(dir);

    const refreshed = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(refreshed).not.toContain('An old rule from a previous release.');
    expect(refreshed).toContain('do not stop until a verdict exists');
    expect(refreshed.startsWith('# My project\n\nSome notes I wrote myself.\n')).toBe(true);
    expect(refreshed.endsWith('\n\nMore of my own notes, after the block.')).toBe(true);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(unmanaged);
    expect(exec).not.toHaveBeenCalled();
  });

  it('prints a manual recovery command when the old Windows updater cannot spawn npm', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    checkForUpdate.mockRejectedValueOnce(new Error('spawn EINVAL'));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await handleUpdate();

    const output = write.mock.calls.flat().join('');
    expect(output).toContain('reticle_update_failed');
    expect(output).toContain('install/install.ps1');
    expect(output).toContain('PowerShell');
    expect(process.exitCode).toBe(1);
  });
});

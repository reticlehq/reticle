import { afterEach, describe, expect, it, vi } from 'vitest';

const { checkForUpdate, exec } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  exec: vi.fn(() => true),
}));

vi.mock('@/command/update/update-checker.js', () => ({ checkForUpdate }));
vi.mock('@reticlehq/init', () => ({
  refreshAgentRules: vi.fn(() => ({ updated: [] })),
  detectPackageManager: vi.fn(() => 'npm'),
  buildNodeIo: vi.fn(() => ({ rootFiles: () => [], listDirs: () => [], exec })),
  installCommandParts: (_pm: string, specs: string[]) => ({
    command: 'npm',
    args: ['i', ...specs],
  }),
  SILENT_HOST: {},
}));

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

  it('says where to run it when this folder has no Reticle SDK', async () => {
    checkForUpdate.mockResolvedValueOnce({ latestVersion: SERVER_VERSION });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleUpdate(mkdtempSync(join(tmpdir(), 'reticle-update-empty-')));

    expect(exec).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('')).toContain("app's folder");
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

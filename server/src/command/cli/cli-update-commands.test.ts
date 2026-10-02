import { afterEach, describe, expect, it, vi } from 'vitest';

const { checkForUpdate } = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));

vi.mock('@/command/update/update-checker.js', () => ({ checkForUpdate }));
vi.mock('@reticlehq/init', () => ({
  refreshAgentRules: vi.fn(() => ({ updated: [] })),
  detectPackageManager: vi.fn(),
  buildNodeIo: vi.fn(),
  SILENT_HOST: {},
}));

import { handleUpdate } from './cli-update-commands.js';

describe('handleUpdate', () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    process.exitCode = undefined;
    vi.restoreAllMocks();
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

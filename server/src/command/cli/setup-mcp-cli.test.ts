import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSetupInstall, handleSetupMcp } from './setup-mcp-cli.js';
import { setupMcp } from '@/command/setup/setup-mcp.js';
import { registerOtherAgents } from '@/command/setup/setup-command.js';

vi.mock('@/command/setup/setup-mcp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/command/setup/setup-mcp.js')>()),
  setupMcp: vi.fn(),
}));
vi.mock('@/command/setup/setup-command.js', () => ({ registerOtherAgents: vi.fn() }));

const exitCode = process.exitCode;
const lines: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  lines.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
});

describe('MCP registration failures reach the user and caller', () => {
  it('prints a retry command and exits nonzero while still registering other agents', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['claude-code'],
      registered: [],
      alreadyThere: [],
      manual: [],
      failed: ['claude-code'],
    });
    handleSetupMcp(vi.fn());
    const output = lines.join('');
    expect(output).toContain('registration failed');
    expect(output).toContain('claude mcp add reticle');
    expect(process.exitCode).toBe(1);
    expect(registerOtherAgents).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful registration successful', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['claude-code'],
      registered: ['claude-code'],
      alreadyThere: [],
      manual: [],
      failed: [],
    });
    handleSetupMcp(vi.fn());
    expect(process.exitCode).toBeUndefined();
  });
});

describe('setup install prints progress only', () => {
  it('leaves the next step and the agent prompt to the installer', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['claude-code'],
      registered: ['claude-code'],
      alreadyThere: [],
      manual: [],
      failed: [],
    });
    handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    const output = lines.join('');
    expect(output).not.toContain('Reticle is installed');
    expect(output).not.toContain('Next:');
  });
});

describe('setup install tells the launcher what it found, in one line it strips', () => {
  const result = (registered: string[], alreadyThere: string[] = []) => ({
    detected: [...registered, ...alreadyThere],
    registered,
    alreadyThere,
    manual: [],
    failed: [],
  });

  it('counts the coding agents that have the tools now', () => {
    vi.mocked(setupMcp).mockReturnValue(result(['claude-code'], ['cursor']));
    handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    expect(lines.join('')).toMatch(/^RETICLE_INSTALL agents=2 app=(here|none)$/m);
  });

  it('says zero when no coding agent is on this machine, so the next step is not "restart it"', () => {
    vi.mocked(setupMcp).mockReturnValue({ ...result([]), detected: [] });
    handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    expect(lines.join('')).toMatch(/^RETICLE_INSTALL agents=0 /m);
  });

  it('says whether the folder it ran in is an app, so the launcher can say "here" or "cd"', () => {
    vi.mocked(setupMcp).mockReturnValue(result(['claude-code']));
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'setup-install-'));
    try {
      process.chdir(dir);
      handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
      writeFileSync(join(dir, 'package.json'), '{}');
      handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    } finally {
      process.chdir(cwd);
    }
    const found = lines.join('').match(/^RETICLE_INSTALL .*$/gm);
    expect(found).toEqual([
      'RETICLE_INSTALL agents=1 app=none',
      'RETICLE_INSTALL agents=1 app=here',
    ]);
  });
});

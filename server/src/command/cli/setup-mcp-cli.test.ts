import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

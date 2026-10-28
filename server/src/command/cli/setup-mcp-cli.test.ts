import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSetupInstall, handleSetupMcp, shouldWaitForAgents } from './setup-mcp-cli.js';
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
      pluginActive: [],
      duplicates: [],
      stale: [],
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
      pluginActive: [],
      duplicates: [],
      stale: [],
    });
    handleSetupMcp(vi.fn());
    expect(process.exitCode).toBeUndefined();
  });
});

describe('setup mcp names one next step per agent, and waits only for a person', () => {
  it('prints the agents block and does not wait when nobody watches', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['cursor', 'codex'],
      registered: ['cursor', 'codex'],
      alreadyThere: [],
      manual: [],
      failed: [],
      pluginActive: [],
      duplicates: [],
      stale: [],
    });
    handleSetupMcp(vi.fn());
    const output = lines.join('');
    expect(output).toContain('Your agents:');
    expect(output).toContain('Cursor       added: restart Cursor');
    expect(output).toContain('Codex        added: restart Codex, then /mcp shows reticle');
    expect(output).not.toContain('Waiting');
  });

  it('waits in a terminal, and never in CI or with no terminal', () => {
    expect(shouldWaitForAgents(true, false)).toBe(true);
    expect(shouldWaitForAgents(true, true)).toBe(false);
    expect(shouldWaitForAgents(false, false)).toBe(false);
    expect(shouldWaitForAgents(undefined, false)).toBe(false);
  });
});

describe('the Reticle plugin row', () => {
  it('says the plugin is active and counts Claude Code', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['claude-code'],
      registered: [],
      alreadyThere: [],
      manual: [],
      failed: [],
      pluginActive: ['claude-code'],
      duplicates: [],
      stale: [],
    });
    expect(handleSetupMcp(vi.fn())).toBe(1);
    const output = lines.join('');
    expect(output).toContain('Claude Code  plugin active: type /reload-plugins if it is open');
    expect(output).not.toContain('claude mcp remove');
  });

  it('prints the one command that removes a duplicate user-scope entry', () => {
    vi.mocked(setupMcp).mockReturnValue({
      detected: ['claude-code'],
      registered: [],
      alreadyThere: [],
      manual: [],
      failed: [],
      pluginActive: ['claude-code'],
      duplicates: ['claude-code'],
      stale: [],
    });
    handleSetupMcp(vi.fn());
    expect(lines.join('')).toContain(
      'Claude Code  plugin active: type /reload-plugins if it is open\n    ⚠ a user-scope reticle server is registered too, so Claude Code has two. Remove it: claude mcp remove reticle -s user',
    );
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
      pluginActive: [],
      duplicates: [],
      stale: [],
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
    pluginActive: [],
    duplicates: [],
    stale: [],
  });

  it('counts the coding agents that have the tools now', () => {
    vi.mocked(setupMcp).mockReturnValue(result(['claude-code'], ['cursor']));
    handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    expect(lines.join('')).toMatch(/^RETICLE_INSTALL agents=2 app=(here|none) wait=yes$/m);
  });

  it('says zero when no coding agent is on this machine, so the next step is not "restart it"', () => {
    vi.mocked(setupMcp).mockReturnValue({ ...result([]), detected: [] });
    handleSetupInstall({ runtimeSecs: 1, installSecs: 1, mcp: true }, vi.fn());
    expect(lines.join('')).toMatch(/^RETICLE_INSTALL agents=0 app=(here|none)$/m);
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
      'RETICLE_INSTALL agents=1 app=none wait=yes',
      'RETICLE_INSTALL agents=1 app=here wait=yes',
    ]);
  });
});

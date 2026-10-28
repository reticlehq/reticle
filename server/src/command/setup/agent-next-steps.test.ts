/**
 * After registration, each agent gets ONE next step, and then the installer says which agents
 * really connected.
 *
 * The defect these pin: the installer printed `✓ cursor` and one shared "Restart your agent" line.
 * That line is wrong for the Claude Code plugin, which loads with `/reload-plugins`, and it says
 * nothing per client. A person with three agents did not know which one still needed a step. And
 * nothing said whether any agent connected after the step, so "it did not work" had no evidence.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentClient } from '@reticlehq/core/telemetry';
import {
  AgentReg,
  agentLines,
  agentRows,
  agentStatuses,
  awaitedClients,
  claudePluginActive,
  connectionLines,
  installedAgentRows,
  waitForAgents,
} from './agent-next-steps.js';

const result = {
  detected: ['claude-code', 'cursor', 'codex'],
  registered: ['cursor', 'codex'],
  alreadyThere: ['claude-code'],
  failed: [],
  manual: [],
};

describe('detection becomes one line per agent, with its own next step', () => {
  it('names the plugin reload for Claude Code and a restart for the others', () => {
    const lines = agentLines(agentRows(result, true));
    expect(lines[0]).toBe('Your agents:');
    expect(lines).toContain('  Claude Code  plugin active: type /reload-plugins if it is open');
    expect(lines).toContain(
      '  Cursor       added: restart Cursor, then turn Reticle on in Settings › MCP',
    );
    expect(lines).toContain('  Codex        added: restart Codex, then /mcp shows reticle');
  });

  it('never claims a reload is enough for a `claude mcp add` registration', () => {
    const lines = agentLines(
      agentRows({ ...result, registered: ['claude-code'], alreadyThere: [] }, false),
    );
    const claude = lines.find((l) => l.includes('Claude Code')) ?? '';
    expect(claude).toContain('restart Claude Code');
    expect(claude).not.toContain('/reload-plugins');
  });

  it('names the launcher that run registered in the retry command', () => {
    const lines = agentLines(
      agentRows(
        {
          detected: ['claude-code'],
          registered: [],
          alreadyThere: [],
          failed: ['claude-code'],
          manual: [],
        },
        false,
        '/opt/reticle/bin/reticle',
      ),
    );
    expect(lines.join('\n')).toContain(
      'registration failed: run `claude mcp add reticle -s user -- node /opt/reticle/bin/reticle mcp`',
    );
  });

  it('names the step still missing for a failed or hand-edit client', () => {
    const lines = agentLines(
      agentRows(
        {
          detected: ['claude-code', 'codex'],
          registered: [],
          alreadyThere: [],
          failed: ['claude-code'],
          manual: [{ id: 'codex', configPath: '/h/.codex/config.toml', docs: undefined }],
        },
        false,
      ),
    );
    expect(lines.join('\n')).toContain(
      'Claude Code  registration failed: run `claude mcp add reticle',
    );
    expect(lines.join('\n')).toContain(
      'Codex        not added: add the reticle entry to /h/.codex/config.toml',
    );
  });
});

describe('a connected client reads ✓, any other names its missing step', () => {
  const rows = agentRows(result, true);

  it('reads ✓ for a client the record holds, and the step for the others', () => {
    const lines = connectionLines(rows, new Set([AgentClient.CLAUDE_CODE]));
    expect(lines).toContain('Connected: Claude Code ✓');
    expect(lines).toContain(
      'Cursor not connected yet: restart Cursor, then turn Reticle on in Settings › MCP',
    );
    expect(lines).toContain('Codex not connected yet: restart Codex, then /mcp shows reticle');
  });

  it('gives status the same facts as structured fields', () => {
    const statuses = agentStatuses(rows, new Set([AgentClient.CODEX]));
    expect(statuses).toContainEqual({
      name: 'Codex',
      connected: true,
      said: 'Connected: Codex ✓',
    });
    expect(statuses).toContainEqual({
      name: 'Cursor',
      connected: false,
      next: 'restart Cursor, then turn Reticle on in Settings › MCP',
      said: 'Cursor not connected yet: restart Cursor, then turn Reticle on in Settings › MCP',
    });
  });

  it('waits only for clients that have Reticle registered', () => {
    const failed = agentRows(
      { detected: ['cursor'], registered: [], alreadyThere: [], failed: ['cursor'], manual: [] },
      false,
    );
    expect(awaitedClients(failed)).toEqual([]);
    expect(awaitedClients(rows)).toEqual([
      AgentClient.CLAUDE_CODE,
      AgentClient.CURSOR,
      AgentClient.CODEX,
    ]);
  });
});

describe('the wait is bounded by an injected clock', () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('stops as soon as every awaited client has connected', async () => {
    const c = clock();
    const seen = new Set<string>();
    const read = (): ReadonlySet<string> => {
      if (c.now() >= 3000) {
        seen.add(AgentClient.CURSOR);
      }
      return seen;
    };
    const got = await waitForAgents([AgentClient.CURSOR], read, c, 60_000, 1000);
    expect(got.has(AgentClient.CURSOR)).toBe(true);
    expect(c.now()).toBe(3000);
  });

  it('gives up at the budget and returns what it saw', async () => {
    const c = clock();
    const got = await waitForAgents([AgentClient.CODEX], () => new Set(), c, 5000, 1000);
    expect(got.size).toBe(0);
    expect(c.now()).toBe(5000);
  });
});

describe('the Claude Code plugin is read from its own install record', () => {
  it('is active when installed_plugins.json names reticle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-'));
    mkdirSync(join(dir, 'plugins'));
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'reticle@reticlehq': [{ scope: 'user' }] } }),
    );
    expect(claudePluginActive(dir)).toBe(true);
  });

  it('is not active when the file is absent or names another plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-'));
    expect(claudePluginActive(dir)).toBe(false);
    mkdirSync(join(dir, 'plugins'));
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'other@x': [] } }),
    );
    expect(claudePluginActive(dir)).toBe(false);
  });
});

describe('status rows come from the configs, read only', () => {
  const home = '/h';
  function io(files: Record<string, string>) {
    return {
      exists: (p: string) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
      readFile: (p: string) => files[p] ?? null,
      homeDir: () => home,
    };
  }

  it('reads Reticle in a config as set up, and its absence as the missing step', () => {
    const rows = installedAgentRows(
      io({
        '/h/.claude.json': JSON.stringify({ mcpServers: { reticle: { command: 'npx' } } }),
        '/h/.cursor/mcp.json': JSON.stringify({ mcpServers: {} }),
      }),
      undefined,
      false,
    );
    expect(rows).toEqual([
      { id: 'claude-code', reg: AgentReg.ALREADY },
      { id: 'cursor', reg: AgentReg.MISSING },
    ]);
    expect(agentStatuses(rows, new Set([AgentClient.CLAUDE_CODE]))).toEqual([
      { name: 'Claude Code', connected: true, said: 'Connected: Claude Code ✓' },
      {
        name: 'Cursor',
        connected: false,
        next: 'not added: run `reticle setup mcp`',
        said: 'Cursor not added: run `reticle setup mcp`',
      },
    ]);
  });

  it('reads an entry that starts an installed launcher as set up, not as missing', () => {
    const rows = installedAgentRows(
      io({
        '/h/.cursor/mcp.json': JSON.stringify({
          mcpServers: {
            reticle: {
              command: 'node',
              args: ['/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js', 'mcp'],
            },
          },
        }),
      }),
      undefined,
      false,
    );
    expect(rows).toEqual([{ id: 'cursor', reg: AgentReg.ALREADY }]);
  });

  it('reads the plugin as set up, and lists no client that is not on the machine', () => {
    expect(installedAgentRows(io({}), undefined, true)).toEqual([
      { id: 'claude-code', reg: AgentReg.PLUGIN },
    ]);
    expect(installedAgentRows(io({}), undefined, false)).toEqual([]);
  });
});

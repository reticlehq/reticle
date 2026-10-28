/**
 * After registration, each agent gets ONE next step, and then the installer says which agents
 * really connected.
 *
 * The defect these pin: the installer printed `✓ cursor` and one shared "Restart your agent" line.
 * That line is wrong for the Claude Code plugin, which loads with `/reload-plugins`, and it says
 * nothing per client. A person with three agents did not know which one still needed a step. And
 * nothing said whether any agent connected after the step, so "it did not work" had no evidence.
 */
import { describe, expect, it } from 'vitest';
import { AgentClient } from '@reticlehq/core/telemetry';
import { claudeStaleEntryNote } from '@reticlehq/init';
import {
  AgentReg,
  agentLines,
  agentRows,
  agentStatuses,
  awaitedClients,
  connectionLines,
  installedAgentRows,
  waitForAgents,
} from './agent-next-steps.js';

const NO_PLUGIN = { pluginActive: [], duplicates: [], stale: [] };

/** Claude Code through the plugin; Cursor and Codex added. */
const result = {
  detected: ['claude-code', 'cursor', 'codex'],
  registered: ['cursor', 'codex'],
  alreadyThere: [],
  failed: [],
  manual: [],
  pluginActive: ['claude-code'],
  duplicates: [],
  stale: [],
};

describe('detection becomes one line per agent, with its own next step', () => {
  it('names the plugin reload for Claude Code and a restart for the others', () => {
    const lines = agentLines(agentRows(result));
    expect(lines[0]).toBe('Your agents:');
    expect(lines).toContain('  Claude Code  plugin active: type /reload-plugins if it is open');
    expect(lines).toContain(
      '  Cursor       added: restart Cursor, then turn Reticle on in Settings › MCP',
    );
    expect(lines).toContain('  Codex        added: restart Codex, then /mcp shows reticle');
  });

  it('never claims a reload is enough for a `claude mcp add` registration', () => {
    const lines = agentLines(agentRows({ ...result, ...NO_PLUGIN, registered: ['claude-code'] }));
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
          ...NO_PLUGIN,
        },
        '/opt/reticle/bin/reticle',
      ),
    );
    expect(lines.join('\n')).toContain(
      'registration failed: run `claude mcp add reticle -s user -- node /opt/reticle/bin/reticle mcp`',
    );
  });

  it('names the step still missing for a failed or hand-edit client', () => {
    const lines = agentLines(
      agentRows({
        detected: ['claude-code', 'codex'],
        registered: [],
        alreadyThere: [],
        failed: ['claude-code'],
        manual: [{ id: 'codex', configPath: '/h/.codex/config.toml', docs: undefined }],
        ...NO_PLUGIN,
      }),
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
  const rows = agentRows(result);

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
    const failed = agentRows({
      detected: ['cursor'],
      registered: [],
      alreadyThere: [],
      failed: ['cursor'],
      manual: [],
      ...NO_PLUGIN,
    });
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

describe('a user-scope entry next to the plugin is named in the block, with its remove command', () => {
  it('prints the warning under the Claude Code row', () => {
    const lines = agentLines(agentRows({ ...result, duplicates: ['claude-code'] }));
    const at = lines.indexOf('  Claude Code  plugin active: type /reload-plugins if it is open');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(
      '    ⚠ a user-scope reticle server is registered too, so Claude Code has two. Remove it: claude mcp remove reticle -s user',
    );
  });

  it('prints no warning for the plugin alone', () => {
    expect(agentLines(agentRows(result)).join('\n')).not.toContain('claude mcp remove');
  });
});

describe('status rows come from the configs, read only', () => {
  const home = '/h';
  // The product joins paths with `node:path`, so on Windows it asks for `\h\.claude.json`.
  // The fake keys files by `/`, so it compares in that one form.
  const slash = (p: string): string => p.replaceAll('\\', '/');
  function io(files: Record<string, string>) {
    return {
      exists: (p: string) =>
        Object.keys(files).some((f) => f === slash(p) || f.startsWith(`${slash(p)}/`)),
      readFile: (p: string) => files[slash(p)] ?? null,
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

  it('reads a user-scope entry next to the plugin as a duplicate', () => {
    const rows = installedAgentRows(
      io({ '/h/.claude.json': JSON.stringify({ mcpServers: { reticle: { command: 'npx' } } }) }),
      undefined,
      true,
    );
    expect(rows).toEqual([{ id: 'claude-code', reg: AgentReg.PLUGIN, duplicate: true }]);
  });

  it('reads the plugin as set up, and lists no client that is not on the machine', () => {
    expect(installedAgentRows(io({}), undefined, true)).toEqual([
      { id: 'claude-code', reg: AgentReg.PLUGIN },
    ]);
    expect(installedAgentRows(io({}), undefined, false)).toEqual([]);
  });
});

/**
 * A user who registered before the pinned entry keeps the floating `npx @reticlehq/server mcp`, and
 * every run said "already set up". The block now names it as stale with the commands that replace
 * it. Nothing removes it: a Claude Code entry is changed only by the person.
 */
describe('a floating npx entry for Claude Code is named as stale, with the commands that replace it', () => {
  const LAUNCHER = '/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js';
  const floating = JSON.stringify({
    mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server', 'mcp'] } },
  });
  const io = (claude: string) => ({
    exists: (p: string) => '/h/.claude.json' === p.replaceAll('\\', '/'),
    readFile: (p: string) => ('/h/.claude.json' === p.replaceAll('\\', '/') ? claude : null),
    homeDir: () => '/h',
  });

  it('prints the stale line under the Claude Code row of a setup run', () => {
    const lines = agentLines(
      agentRows(
        {
          ...result,
          ...NO_PLUGIN,
          detected: ['claude-code'],
          registered: [],
          alreadyThere: ['claude-code'],
          stale: ['claude-code'],
        },
        LAUNCHER,
      ),
    );
    const at = lines.indexOf('  Claude Code  already set up');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(`    ⚠ ${claudeStaleEntryNote(LAUNCHER)}`);
  });

  it('reads it from the config for status and init', () => {
    const rows = installedAgentRows(io(floating), undefined, false, '/h', LAUNCHER);
    expect(rows).toEqual([
      { id: 'claude-code', reg: AgentReg.ALREADY, stale: claudeStaleEntryNote(LAUNCHER) },
    ]);
  });

  it('says nothing for a pinned entry', () => {
    const pinned = JSON.stringify({
      mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server@3.8.0', 'mcp'] } },
    });
    expect(installedAgentRows(io(pinned), undefined, false, '/h', LAUNCHER)).toEqual([
      { id: 'claude-code', reg: AgentReg.ALREADY },
    ]);
  });
});

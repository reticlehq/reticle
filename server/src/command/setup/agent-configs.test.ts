import { describe, expect, it } from 'vitest';
import {
  AGENT_CLIENTS,
  AgentAction,
  AgentConfidence,
  parentOf,
  planAgentConfigs,
  type AgentPlanStep,
} from './agent-configs.js';

const HOME = '/home/u';
/** A win32 plan is asked for with a win32 home; a `/home/u` on Windows is not a thing. */
const WIN_HOME = 'C:\\Users\\u';

/** A pretend filesystem, so every platform's rows are checked from any machine. */
const fs = (files: Record<string, string>) => ({
  exists: (p: string) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
  readFile: (p: string) => files[p] ?? '',
});

const plan = (files: Record<string, string>, platform: 'darwin' | 'linux' | 'win32' = 'darwin') =>
  planAgentConfigs({ home: 'win32' === platform ? WIN_HOME : HOME, platform, ...fs(files) });
const by = (rows: AgentPlanStep[], id: string) => rows.find((r) => r.id === id);

describe('registering with the agents init does not reach', () => {
  const bare = plan({});

  it('creates a documented path even when the agent is absent, so a later install is wired', () => {
    expect(by(bare, 'zed')?.action).toBe(AgentAction.CREATE);
  });

  // A config file at a guessed location is one nobody reads, which looks exactly like success.
  it('refuses a community path when nothing on the machine evidences it', () => {
    expect(by(bare, 'cline')?.action).toBe(AgentAction.SKIP);
    expect(by(bare, 'cline')?.why).toContain('guess');
  });

  it("writes a community path once the host's own layout is present", () => {
    const withVscode = plan({
      [`${HOME}/Library/Application Support/Code/User/settings.json`]: '{}',
    });
    expect(by(withVscode, 'cline')?.action).toBe(AgentAction.CREATE);
    expect(by(withVscode, 'roo-code')?.action).toBe(AgentAction.CREATE);
  });

  it('targets VS Code user scope, which init never writes', () => {
    expect(by(bare, 'vscode-user')?.file).toBe(
      `${HOME}/Library/Application Support/Code/User/mcp.json`,
    );
    // Backslashes, and asserted literally: the separator IS the thing this checks. A win32 row
    // built with `/` is a path Windows cannot open, and that is what shipped until joinFor.
    expect(by(plan({}, 'win32'), 'vscode-user')?.file).toBe(
      `${WIN_HOME}\\AppData\\Roaming\\Code\\User\\mcp.json`,
    );
  });

  it('follows XDG on linux', () => {
    expect(by(plan({}, 'linux'), 'zed')?.file).toBe(`${HOME}/.config/zed/settings.json`);
  });
});

// Getting a key wrong writes a file the client silently ignores, which is the quietest way to
// believe you have registered something.
describe('per-client keys', () => {
  it('uses context_servers for Zed, not mcpServers', () => {
    expect(by(plan({}), 'zed')?.key).toBe('context_servers');
  });

  it('uses a dotted top-level key for Amp', () => {
    expect(by(plan({}), 'amp')?.key).toBe('amp.mcpServers');
  });

  it('uses servers for VS Code', () => {
    expect(by(plan({}), 'vscode-user')?.key).toBe('servers');
  });
});

describe('never clobbering somebody else', () => {
  const warp = `${HOME}/.warp/.mcp.json`;

  it('merges into a config that already has other servers', () => {
    const rows = plan({ [warp]: JSON.stringify({ mcpServers: { other: { command: 'x' } } }) });
    expect(by(rows, 'warp')?.action).toBe(AgentAction.MERGE);
  });

  it('leaves a foreign reticle entry alone', () => {
    const rows = plan({
      [warp]: JSON.stringify({ mcpServers: { reticle: { command: 'somebody-elses' } } }),
    });
    expect(by(rows, 'warp')?.action).toBe(AgentAction.MANUAL);
  });

  it('recognises our own entry as already done', () => {
    const rows = plan({
      [warp]: JSON.stringify({
        mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server', 'mcp'] } },
      }),
    });
    expect(by(rows, 'warp')?.action).toBe(AgentAction.ALREADY);
  });

  it('leaves a commented config for a human rather than stripping the comments', () => {
    const rows = plan({ [`${HOME}/.config/zed/settings.json`]: '{ // theme\n "theme": "dark" }' });
    expect(by(rows, 'zed')?.action).toBe(AgentAction.MANUAL);
  });
});

describe('yaml', () => {
  it('creates one when there is no formatting to damage', () => {
    expect(by(plan({}), 'continue')?.action).toBe(AgentAction.CREATE_YAML);
  });

  it('never rewrites one that exists', () => {
    expect(by(plan({ [`${HOME}/.continue/config.yaml`]: 'x' }), 'continue')?.action).toBe(
      AgentAction.MANUAL,
    );
  });
});

// The guard for the class of bug joinFor removed. It is host-independent by construction: the
// separator asserted comes from the platform ARGUMENT, so this reddens on a mac the moment a
// planner reaches for `node:path`'s bare `join` again, instead of waiting for a Windows runner.
describe('a plan belongs to the platform it was asked for, not the host', () => {
  it('uses that platform\u2019s separator in every path it produces', () => {
    for (const [platform, home, wrong] of [
      ['darwin', HOME, '\\\\'],
      ['linux', HOME, '\\\\'],
      ['win32', WIN_HOME, '/'],
    ] as const) {
      const rows = planAgentConfigs({ home, platform, ...fs({}) });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.file).not.toContain(wrong);
    }
  });
});

// The other half of the same bug joinFor fixed: the planners learned to WRITE the right separator
// and the writers never learned to READ it. `parentOf` was `slice(0, lastIndexOf('/'))`, so on a
// win32 path — which has no '/' at all — lastIndexOf returned -1, the slice returned '' and the
// writer called mkdir(''). A Windows install of 3.1.0 lost twelve of thirteen agent registrations
// to `ENOENT: mkdir ''` in one run, Claude Code among them, while reporting the rest as fine.
describe('the parent of a path is read with the separator the path actually uses', () => {
  it('finds the directory of a win32 path, which has no forward slash in it', () => {
    expect(parentOf('C:\\Users\\u\\AppData\\Roaming\\Code\\User\\mcp.json')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Code\\User',
    );
  });

  it('finds the directory of a posix path', () => {
    expect(parentOf('/home/u/.config/zed/settings.json')).toBe('/home/u/.config/zed');
  });

  it('never answers with the empty string, which is what mkdir cannot take', () => {
    for (const path of ['mcp.json', 'C:\\mcp.json', '/mcp.json', 'C:\\Users\\u\\mcp.json']) {
      expect(parentOf(path), `parentOf(${path})`).not.toBe('');
    }
  });

  it('answers for every path the planner produces, on every platform', () => {
    for (const [platform, home] of [
      ['darwin', HOME],
      ['linux', HOME],
      ['win32', WIN_HOME],
    ] as const) {
      for (const row of planAgentConfigs({ home, platform, ...fs({}) })) {
        expect(parentOf(row.file), `${platform}: ${row.file}`).not.toBe('');
      }
    }
  });
});

// A YAML config is created once and never rewritten, which was right — but "exists" was standing in
// for "somebody else wrote this". On the SECOND `reticle init`, the file Reticle itself wrote on the
// first run came back as MANUAL, and the run closed by telling the user to go and add, by hand, the
// exact entry sitting in that file. Every re-run after the first said it, and re-running init is the
// documented upgrade path, so it is the run most people see.
describe('a YAML config we already wrote is not somebody else to defer to', () => {
  const CONTINUE = `${HOME}/.continue/config.yaml`;
  const OURS =
    'mcpServers:\n  - name: reticle\n    type: stdio\n    command: npx\n    args: ["@reticlehq/server", "mcp"]\n';

  it('writes one when there is none', () => {
    expect(by(plan({}), 'continue')?.action).toBe(AgentAction.CREATE_YAML);
  });

  it('reports the one it already wrote as done, not as a manual step', () => {
    expect(by(plan({ [CONTINUE]: OURS }), 'continue')?.action).toBe(AgentAction.ALREADY);
  });

  // The negative control, and the reason the MANUAL branch exists at all: a config somebody else
  // owns still gets left alone, comments and ordering intact.
  it('still defers to a config that is somebody else’s', () => {
    const theirs = '# my setup\nmcpServers:\n  - name: something-else\n    command: node\n';
    expect(by(plan({ [CONTINUE]: theirs }), 'continue')?.action).toBe(AgentAction.MANUAL);
  });
});

describe('the registry itself', () => {
  it('declares a confidence for every client', () => {
    expect(AGENT_CLIENTS.every((c) => Object.values(AgentConfidence).includes(c.confidence))).toBe(
      true,
    );
  });

  it('declares all three platforms for every client', () => {
    expect(AGENT_CLIENTS.every((c) => c.paths.darwin && c.paths.linux && c.paths.win32)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { runInit } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import {
  claudeAddCommand,
  claudeHasReticle,
  mcpManual,
  mcpWindowsNote,
  MCP_SERVER_NAME,
} from './mcp.js';

describe('claudeAddCommand', () => {
  it('registers reticle at user scope via npx (global, all projects)', () => {
    const c = claudeAddCommand();
    expect(c.command).toBe('claude');
    expect(c.args).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '-s',
      'user',
      '--',
      'npx',
      '@reticlehq/server',
      'mcp',
    ]);
  });

  it('is portless — never bakes a port into the global registration', () => {
    // A single global entry serves every project; the port is resolved per-project from
    //.reticle.json at runtime. Baking --port here would pin all projects to one port.
    const c = claudeAddCommand();
    expect(c.args).not.toContain('--port');
    expect(c.display).not.toContain('--port');
    expect(c.display).toBe('claude mcp add reticle -s user -- npx @reticlehq/server mcp');
  });
});

/**
 * `claude mcp get reticle` health-checks the entry by LAUNCHING it: `npx @reticlehq/server mcp` in
 * the project, which starts a daemon on whatever `.reticle.json` says — before `init` has rewritten
 * it. A port move resurrected the old-port daemon about two seconds after it was stopped.
 * Registration is read from Claude's config instead.
 */
describe('claudeHasReticle', () => {
  const HOME = '/home/u';
  const APP = '/work/app';
  const entry = { command: 'npx', args: ['@reticlehq/server', 'mcp'] };
  const files = (
    over: Record<string, unknown>,
  ): { readFile: (p: string) => string | null; homeDir: () => string } => ({
    readFile: (p) => {
      const value = over[p.replace(/\\/g, '/')];
      return value === undefined ? null : JSON.stringify(value);
    },
    homeDir: () => HOME,
  });

  it('finds a user-scope entry', () => {
    expect(
      claudeHasReticle(
        files({ [`${HOME}/.claude.json`]: { mcpServers: { reticle: entry } } }),
        APP,
        undefined,
      ),
    ).toBe(true);
  });

  it('finds a local-scope entry for this project, and not for another', () => {
    const config = {
      [`${HOME}/.claude.json`]: { projects: { [APP]: { mcpServers: { reticle: entry } } } },
    };
    expect(claudeHasReticle(files(config), APP, undefined)).toBe(true);
    expect(claudeHasReticle(files(config), '/work/other', undefined)).toBe(false);
  });

  it('finds a project-scope .mcp.json', () => {
    expect(
      claudeHasReticle(
        files({ [`${APP}/.mcp.json`]: { mcpServers: { reticle: entry } } }),
        APP,
        undefined,
      ),
    ).toBe(true);
  });

  it('reads the config dir Claude was told to use', () => {
    const io = files({ '/cfg/.claude.json': { mcpServers: { reticle: entry } } });
    expect(claudeHasReticle(io, APP, '/cfg')).toBe(true);
    expect(claudeHasReticle(io, APP, undefined)).toBe(false);
  });

  it('is false with no entry, and for a config it cannot parse', () => {
    expect(
      claudeHasReticle(
        files({ [`${HOME}/.claude.json`]: { mcpServers: { other: entry } } }),
        APP,
        undefined,
      ),
    ).toBe(false);
    expect(
      claudeHasReticle({ readFile: () => '{not json', homeDir: () => HOME }, APP, undefined),
    ).toBe(false);
  });
});

describe('init never launches the MCP server to check registration', () => {
  it('spawns no `claude mcp get` (or list) at all', () => {
    const ran: string[] = [];
    const io = memoryIo({
      'package.json': JSON.stringify({
        name: 'a',
        dependencies: { react: '^19.0.0' },
        devDependencies: { vite: '^7.0.0' },
      }),
      'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
    });
    const recorded = {
      ...io,
      probe: (command: string, args: readonly string[]) => {
        ran.push(`${command} ${args.join(' ')}`);
        return true;
      },
      exec: (command: string, args: readonly string[]) => {
        ran.push(`${command} ${args.join(' ')}`);
        return true;
      },
    };
    runInit(
      { cwd: '/project', port: undefined, mcp: true, install: false, dryRun: false },
      recorded,
    );
    expect(
      ran.filter((c) => /\bmcp (get|list)\b/.test(c)),
      ran.join(' | '),
    ).toEqual([]);
  });
});

describe('mcpManual', () => {
  it('explains the one-time global registration', () => {
    const m = mcpManual();
    expect(m).toContain('claude mcp add reticle -s user');
    expect(m).toContain('globally');
    expect(m).not.toContain('--port');
  });

  it('includes the Windows cmd fallback', () => {
    expect(mcpManual()).toContain(mcpWindowsNote());
  });
});

describe('mcpWindowsNote', () => {
  it('registers through cmd /c npx, not bare npx', () => {
    const n = mcpWindowsNote();
    expect(n).toContain('cmd');
    expect(n).toContain('/c');
    expect(n).toContain('npx');
    expect(n).toContain('@reticlehq/server');
  });
});

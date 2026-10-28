import { describe, expect, it } from 'vitest';
import { runInit } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import { RETICLE_VERSION } from '@/version.js';
import {
  claudeAddCommand,
  claudeHasReticle,
  claudeStaleEntryNote,
  claudeUserEntryIsFloating,
  installedLauncher,
  isReticleRegistration,
  mcpManual,
  mcpWindowsNote,
  MCP_SERVER_NAME,
} from './mcp.js';

/** The exact-version package spec npx must name, so a sandbox image reuses its npm cache. */
const PINNED = `@reticlehq/server@${RETICLE_VERSION}`;

/**
 * A fresh sandbox has an empty npm cache. A floating `npx @reticlehq/server mcp` downloaded the
 * whole package before the MCP server answered, on every boot: 3.9 s to 5.6 s and about 131 MB,
 * against 0.6 s warm. An installed copy is launched directly; without one, npx names one version.
 */
describe('installedLauncher', () => {
  it('uses a global install', () => {
    const bin = '/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js';
    expect(installedLauncher(bin)).toBe(bin);
  });

  it("uses an install in the project's node_modules, also through pnpm's store", () => {
    const npm = '/work/app/node_modules/@reticlehq/server/bin/reticle.js';
    const pnpm =
      '/work/app/node_modules/.pnpm/@reticlehq+server@3.8.2/node_modules/@reticlehq/server/bin/reticle.js';
    expect(installedLauncher(npm)).toBe(npm);
    expect(installedLauncher(pnpm)).toBe(pnpm);
  });

  it('refuses a copy that npx, pnpm dlx, yarn dlx or bunx can delete', () => {
    for (const bin of [
      '/home/u/.npm/_npx/0a1b/node_modules/@reticlehq/server/bin/reticle.js',
      '/home/u/.cache/pnpm/dlx/abc/node_modules/@reticlehq/server/bin/reticle.js',
      '/tmp/xfs-1/dlx-2/node_modules/@reticlehq/server/bin/reticle.js',
      '/tmp/bunx-501-@reticlehq/server@latest/node_modules/@reticlehq/server/bin/reticle.js',
    ]) {
      expect(installedLauncher(bin), bin).toBeUndefined();
    }
  });

  it('refuses a source checkout, which is not an install', () => {
    expect(installedLauncher('/src/reticle/server/bin/reticle.js')).toBeUndefined();
    expect(installedLauncher(undefined)).toBeUndefined();
  });

  it('reads Windows paths', () => {
    const global =
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@reticlehq\\server\\bin\\reticle.js';
    const cached =
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\@reticlehq\\server\\bin\\reticle.js';
    expect(installedLauncher(global)).toBe(global);
    expect(installedLauncher(cached)).toBeUndefined();
  });
});

describe('the registered launch command', () => {
  const LAUNCHER = '/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js';

  it('starts an installed copy with node, and no npx', () => {
    const c = claudeAddCommand(LAUNCHER);
    expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual(['node', LAUNCHER, 'mcp']);
  });

  it('names one exact version when nothing is installed', () => {
    const c = claudeAddCommand();
    expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual(['npx', PINNED, 'mcp']);
  });

  it('keeps the Windows cmd fallback on the same exact version', () => {
    expect(mcpWindowsNote()).toContain(JSON.stringify(['/c', 'npx', PINNED, 'mcp']));
  });

  it('knows a launcher entry as ours, so a re-run repairs it', () => {
    expect(isReticleRegistration(['node', LAUNCHER, 'mcp'])).toBe(true);
    expect(isReticleRegistration(['node', '/home/u/my-build/cli.js', 'mcp'])).toBe(false);
  });
});

describe('claudeAddCommand', () => {
  it('registers reticle at user scope (global, all projects)', () => {
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
      PINNED,
      'mcp',
    ]);
  });

  it('is portless — never bakes a port into the global registration', () => {
    // A single global entry serves every project; the port is resolved per-project from
    //.reticle.json at runtime. Baking --port here would pin all projects to one port.
    const c = claudeAddCommand();
    expect(c.args).not.toContain('--port');
    expect(c.display).not.toContain('--port');
    expect(c.display).toBe(`claude mcp add reticle -s user -- npx ${PINNED} mcp`);
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

/**
 * A user who registered before the pinned entry keeps `npx @reticlehq/server mcp` for ever:
 * `claudeHasReticle` reads any `reticle` entry as registered. npx then starts whatever version its
 * cache holds. Only the floating npx form is stale; a pinned version and an installed launcher are not.
 */
describe('claudeUserEntryIsFloating', () => {
  const HOME = '/home/u';
  const user = (
    entry: unknown,
  ): { readFile: (p: string) => string | null; homeDir: () => string } => ({
    readFile: (p) =>
      `${HOME}/.claude.json` === p.replace(/\\/g, '/')
        ? JSON.stringify({ mcpServers: { reticle: entry } })
        : null,
    homeDir: () => HOME,
  });
  const LAUNCHER = '/usr/local/lib/node_modules/@reticlehq/server/bin/reticle.js';

  it('finds the floating npx form, with or without -y or @latest, and on Windows', () => {
    for (const args of [
      ['@reticlehq/server', 'mcp'],
      ['-y', '@reticlehq/server', 'mcp'],
      ['@reticlehq/server@latest', 'mcp'],
    ]) {
      expect(claudeUserEntryIsFloating(user({ command: 'npx', args }), undefined)).toBe(true);
    }
    expect(
      claudeUserEntryIsFloating(
        user({ command: 'cmd', args: ['/c', 'npx', '@reticlehq/server', 'mcp'] }),
        undefined,
      ),
    ).toBe(true);
  });

  it('leaves a pinned version, an installed launcher and an entry that is not ours alone', () => {
    for (const entry of [
      { command: 'npx', args: [PINNED, 'mcp'] },
      { command: 'npx', args: ['@reticlehq/server@3.7.0', 'mcp'] },
      { command: 'node', args: [LAUNCHER, 'mcp'] },
      { command: 'node', args: ['/my/build/cli.js', 'mcp'] },
    ]) {
      expect(claudeUserEntryIsFloating(user(entry), undefined)).toBe(false);
    }
    expect(
      claudeUserEntryIsFloating({ readFile: () => null, homeDir: () => HOME }, undefined),
    ).toBe(false);
  });

  it('reads only the user scope', () => {
    const io = {
      readFile: (p: string) =>
        `${HOME}/.claude.json` === p.replace(/\\/g, '/')
          ? JSON.stringify({
              projects: {
                '/app': {
                  mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server', 'mcp'] } },
                },
              },
            })
          : null,
      homeDir: () => HOME,
    };
    expect(claudeUserEntryIsFloating(io, undefined)).toBe(false);
  });

  it('names the two commands that replace it, and removes nothing itself', () => {
    const note = claudeStaleEntryNote(LAUNCHER);
    expect(note).toContain('claude mcp remove reticle -s user');
    expect(note).toContain(claudeAddCommand(LAUNCHER).display);
  });
});

describe('init on a machine with the floating Claude Code entry', () => {
  const app = {
    'package.json': JSON.stringify({
      name: 'a',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0' },
    }),
    'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
  };
  const run = (entry: unknown): { lines: string[]; ran: string[] } => {
    const ran: string[] = [];
    const io = memoryIo({
      ...app,
      '/home/u/.claude.json': JSON.stringify({ mcpServers: { reticle: entry } }),
    });
    runInit(
      { cwd: '/project', port: undefined, mcp: true, install: false, dryRun: false },
      {
        ...io,
        exec: (command: string, args: readonly string[]) => {
          ran.push(`${command} ${args.join(' ')}`);
          return true;
        },
      },
    );
    return { lines: io.lines, ran };
  };

  it('reports it as stale with the two commands, and runs neither', () => {
    const { lines, ran } = run({ command: 'npx', args: ['@reticlehq/server', 'mcp'] });
    const text = lines.join('\n');
    expect(text).toContain('claude mcp remove reticle -s user');
    expect(text).toContain('claude mcp add reticle -s user');
    expect(
      ran.filter((c) => /^claude mcp (add|remove)/.test(c)),
      ran.join(' | '),
    ).toEqual([]);
  });

  it('says nothing about a pinned entry', () => {
    const { lines } = run({ command: 'npx', args: [PINNED, 'mcp'] });
    expect(lines.join('\n')).not.toContain('claude mcp remove');
  });
});

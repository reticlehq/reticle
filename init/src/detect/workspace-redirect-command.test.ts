import { describe, expect, it } from 'vitest';
import { SILENT_HOST } from '../host.js';
import type { InitIo, InitOptions } from '../run-types.js';
import { displayedWorkspaceAppCommand, redirectToWorkspaceApp } from './workspace-redirect.js';

const COMPLEX_APP = "apps/admin's %TEMP% & $(echo nope)";

const OPTIONS: InitOptions = {
  cwd: '/project',
  port: undefined,
  mcp: true,
  dryRun: false,
  install: false,
};

function ambiguousWorkspaceIo(lines: string[]): InitIo {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'mono',
      workspaces: ['apps/*'],
    }),
    'apps/web/package.json': JSON.stringify({
      dependencies: { vite: '^7' },
    }),
    'apps/admin/package.json': JSON.stringify({
      dependencies: { next: '^16' },
    }),
  };

  const io: InitIo = {
    readFile: (path) => files[path] ?? null,
    writeFile: () => {},
    exists: (path) => path in files,
    homeDir: () => '/home/u',
    cwd: () => '/project',
    rootFiles: () => ['package.json'],
    listDirs: (path) => {
      if ('.' === path) return ['apps'];
      if ('apps' === path) return ['web', 'admin'];
      return [];
    },
    listFiles: () => [],
    scoped: () => io,
    exec: () => true,
    probe: () => true,
    canWrite: () => true,
    print: (line) => lines.push(line),
    host: SILENT_HOST,
  };

  return io;
}

describe('displayedWorkspaceAppCommand', () => {
  it('leaves an ordinary app path portable and unquoted', () => {
    const expected = {
      command: 'reticle init --app apps/web',
    };

    expect(displayedWorkspaceAppCommand('apps/web', 'linux')).toEqual(expected);
    expect(displayedWorkspaceAppCommand('apps/web', 'darwin')).toEqual(expected);
    expect(displayedWorkspaceAppCommand('apps/web', 'win32')).toEqual(expected);
  });

  it('single-quotes a complex POSIX path without evaluating shell syntax', () => {
    expect(displayedWorkspaceAppCommand(COMPLEX_APP, 'linux')).toEqual({
      command: `reticle init --app 'apps/admin'"'"'s %TEMP% & $(echo nope)'`,
    });
  });

  it('makes a complex Windows command explicitly PowerShell-only', () => {
    expect(displayedWorkspaceAppCommand(COMPLEX_APP, 'win32')).toEqual({
      label: 'PowerShell only:',
      command: `reticle init --app 'apps/admin''s %TEMP% & $(echo nope)'`,
    });
  });

  it('quotes shell syntax even when whitespace alone would not require it', () => {
    expect(displayedWorkspaceAppCommand('apps/admin&tools', 'linux')).toEqual({
      command: `reticle init --app 'apps/admin&tools'`,
    });

    expect(displayedWorkspaceAppCommand('apps/admin&tools', 'win32')).toEqual({
      label: 'PowerShell only:',
      command: `reticle init --app 'apps/admin&tools'`,
    });
  });
});

describe('redirectToWorkspaceApp — ambiguous workspace', () => {
  it('prints a complete command for every discovered app', () => {
    const lines: string[] = [];
    const io = ambiguousWorkspaceIo(lines);

    const result = redirectToWorkspaceApp(
      OPTIONS,
      io,
      JSON.parse(io.readFile('package.json') ?? '{}'),
      () => {
        throw new Error('ambiguous workspace must not enter an app');
      },
    );

    expect(result).toEqual({
      ok: false,
      applied: 0,
      manual: 2,
    });

    const commands = lines.filter((line) => line.startsWith('  reticle init --app '));

    expect(commands).toEqual(['  reticle init --app apps/web', '  reticle init --app apps/admin']);
  });
});

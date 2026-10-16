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

describe('redirectToWorkspaceApp — a page with a manifest at the root', () => {
  // #1695: a folder holding index.html and a package.json IS the app. Discovery preferred a
  // nested copy (a backup of the same app) and `--dry-run` named `backup/` as the target.
  function pageAtRootIo(lines: string[], extra: Record<string, string> = {}): InitIo {
    const files: Record<string, string> = {
      'index.html': '<!doctype html><html><body></body></html>',
      'package.json': JSON.stringify({ name: 'page', scripts: { dev: 'npx serve .' } }),
      'backup/package.json': JSON.stringify({
        name: 'old-copy',
        scripts: { dev: 'vite' },
        devDependencies: { vite: '^7' },
      }),
      'backup/vite.config.ts': 'export default {}',
      'backup/index.html': '<div id="root"></div>',
      ...extra,
    };

    const io: InitIo = {
      readFile: (path) => files[path] ?? null,
      writeFile: () => {},
      exists: (path) => path in files,
      homeDir: () => '/home/u',
      cwd: () => '/project',
      rootFiles: () => ['index.html', 'package.json'],
      listDirs: (path) => {
        if ('.' === path) return 'apps/web/package.json' in files ? ['backup', 'apps'] : ['backup'];
        return 'apps' === path ? ['web'] : [];
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

  it('wires the root, listing rather than choosing a nested app', () => {
    const lines: string[] = [];
    const io = pageAtRootIo(lines);

    const result = redirectToWorkspaceApp(
      OPTIONS,
      io,
      JSON.parse(io.readFile('package.json') ?? '{}'),
      () => {
        throw new Error('a root that is itself the app must not be redirected');
      },
    );

    expect(result).toBeNull();
    expect(lines.filter((line) => line.startsWith('  reticle init --app '))).toEqual([
      '  reticle init --app backup',
    ]);
  });

  it('keeps the app that a stored root pointer names', () => {
    const lines: string[] = [];
    const io = pageAtRootIo(lines, {
      'package.json': JSON.stringify({
        name: 'page',
        workspaces: ['apps/*'],
        scripts: { dev: 'npx serve .' },
      }),
      '.reticle.json': JSON.stringify({ projectId: 'p-1' }),
      'apps/web/package.json': JSON.stringify({ dependencies: { vite: '^7' } }),
      'apps/web/.reticle.json': JSON.stringify({ projectId: 'p-1' }),
    });
    const entered: string[] = [];

    redirectToWorkspaceApp(
      OPTIONS,
      io,
      JSON.parse(io.readFile('package.json') ?? '{}'),
      (options) => {
        entered.push(options.cwd);
        return { ok: true, applied: 0, manual: 0 };
      },
    );

    expect(entered).toEqual(['/project/apps/web']);
  });
});

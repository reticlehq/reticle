/**
 * The agent's MCP entry and every rule file say `npx @reticlehq/server`, which resolves the LATEST
 * server, while the project's SDK stays locked. A project on the previous major got a daemon from the
 * next one and every verdict came back `version_skew`. These tests pin the decision (pure, injected
 * fs and env) and the plumbing (a fake spawner, then a real child for the MCP byte stream).
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { NodePlatform } from '@reticlehq/init';
import {
  SDK_PACKAGES,
  VersionMatchEnv,
  helpRunsAt,
  helpVersionNote,
  installedSdkVersion,
  npxInvocation,
  reexecAtVersion,
  versionToMatch,
  type ReexecChild,
  type ReexecSpawner,
} from './sdk-version-match.js';

const PROJECT = '/work/shop';

function fsWith(files: Record<string, string>): (path: string) => string | undefined {
  return (path) => files[path];
}

function sdkAt(dir: string, pkg: string, version: string): Record<string, string> {
  return { [join(dir, 'node_modules', pkg, 'package.json')]: JSON.stringify({ version }) };
}

function decide(opts: {
  argv?: string[];
  cli?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
}): string | undefined {
  return versionToMatch({
    argv: opts.argv ?? ['status'],
    cliVersion: opts.cli ?? '3.3.0',
    env: opts.env ?? {},
    projectDir: PROJECT,
    readFile: fsWith(opts.files ?? sdkAt(PROJECT, '@reticlehq/react', '2.14.0')),
  });
}

describe('installedSdkVersion', () => {
  it('reads each SDK package the project could have installed', () => {
    for (const pkg of SDK_PACKAGES) {
      expect(installedSdkVersion(PROJECT, fsWith(sdkAt(PROJECT, pkg, '2.9.0')))).toBe('2.9.0');
    }
  });

  it('finds an SDK hoisted to a workspace root above the app', () => {
    expect(
      installedSdkVersion(PROJECT, fsWith(sdkAt('/work', '@reticlehq/browser', '2.14.0'))),
    ).toBe('2.14.0');
  });

  it('is undefined for a project with no SDK installed', () => {
    expect(installedSdkVersion(PROJECT, fsWith({}))).toBeUndefined();
  });
});

describe('versionToMatch', () => {
  it('pins to the SDK when its major differs from the CLI', () => {
    expect(decide({})).toBe('2.14.0');
  });

  it('leaves a minor or patch difference alone', () => {
    expect(decide({ files: sdkAt(PROJECT, '@reticlehq/react', '3.2.0') })).toBeUndefined();
    expect(decide({ files: sdkAt(PROJECT, '@reticlehq/react', '3.3.1') })).toBeUndefined();
  });

  it('does nothing when the project has no SDK', () => {
    expect(decide({ files: {} })).toBeUndefined();
  });

  it('never re-runs a command whose job is to change the version', () => {
    for (const argv of [
      ['init'],
      ['update'],
      ['rollback'],
      ['setup', 'install'],
      ['version'],
      ['--version'],
      ['-v'],
      ['help'],
      ['status', '--help'],
      ['verify', '-h'],
    ]) {
      expect(decide({ argv })).toBeUndefined();
    }
  });

  it('does re-run the commands that serve the project', () => {
    for (const argv of [[], ['mcp'], ['verify', 'http://localhost:5173'], ['setup', 'mcp']]) {
      expect(decide({ argv })).toBe('2.14.0');
    }
  });

  it('never loops: a process that was already re-run stays put', () => {
    expect(decide({ env: { [VersionMatchEnv.REEXECUTED]: '1' } })).toBeUndefined();
  });

  it('honours the opt-out', () => {
    expect(decide({ env: { [VersionMatchEnv.OPT_OUT]: '1' } })).toBeUndefined();
  });

  it('respects a version the user pinned on the npx line', () => {
    expect(
      decide({ env: { [VersionMatchEnv.NPX_PACKAGE]: '@reticlehq/server@3.3.0' } }),
    ).toBeUndefined();
  });

  it('still matches when npx was asked for the bare package', () => {
    expect(decide({ env: { [VersionMatchEnv.NPX_PACKAGE]: '@reticlehq/server' } })).toBe('2.14.0');
    expect(decide({ env: { [VersionMatchEnv.NPX_PACKAGE]: '@reticlehq/server@latest' } })).toBe(
      '2.14.0',
    );
  });

  it('ignores an SDK version that is not a published release', () => {
    expect(decide({ files: sdkAt(PROJECT, '@reticlehq/react', 'workspace:*') })).toBeUndefined();
  });
});

describe('--help under a project that re-runs the command (#1378)', () => {
  const helpFor = (argv: string[], env: Record<string, string> = {}): string | undefined =>
    helpRunsAt({
      argv,
      cliVersion: '3.3.0',
      env,
      projectDir: PROJECT,
      readFile: fsWith(sdkAt(PROJECT, '@reticlehq/react', '2.14.0')),
    });

  it('names the version the command it describes would actually run at', () => {
    for (const argv of [['verify', '--help'], ['verify', '-h'], ['help', 'verify'], ['--help']]) {
      expect(helpFor(argv), argv.join(' ')).toBe('2.14.0');
    }
    const note = helpVersionNote('2.14.0', '3.3.0');
    expect(note).toContain('@reticlehq/server 3.3.0');
    expect(note).toContain('runs at @reticlehq/server@2.14.0');
    expect(note).toContain('npx @reticlehq/server@2.14.0 <command> --help');
    expect(note).toContain(`${VersionMatchEnv.OPT_OUT}=1`);
  });

  it('says nothing when the command runs on this binary anyway', () => {
    expect(helpFor(['init', '--help'])).toBeUndefined();
    expect(helpFor(['help', 'update'])).toBeUndefined();
    expect(helpFor(['verify', '--help'], { [VersionMatchEnv.OPT_OUT]: '1' })).toBeUndefined();
  });

  it('says nothing when help was not asked for', () => {
    expect(helpFor(['verify'])).toBeUndefined();
  });
});

describe('npxInvocation', () => {
  it('runs the pinned server with the same arguments', () => {
    expect(npxInvocation('2.14.0', ['verify', 'a b'], 'darwin')).toEqual({
      file: 'npx',
      argv: ['--yes', '@reticlehq/server@2.14.0', 'verify', 'a b'],
      shell: false,
    });
  });

  it('goes through a shell on Windows, quoting each argument', () => {
    const inv = npxInvocation('2.14.0', ['verify', 'a b'], 'win32');
    expect(inv.shell).toBe(true);
    expect(inv.file).toBe('npx.cmd --yes @reticlehq/server@2.14.0 verify "a b"');
  });
});

/** A child that records what it was asked for and exits with the given code. */
function fakeSpawner(code: number): {
  spawner: ReexecSpawner;
  calls: { file: string; argv: string[]; env: NodeJS.ProcessEnv; stdio: unknown }[];
} {
  const calls: { file: string; argv: string[]; env: NodeJS.ProcessEnv; stdio: unknown }[] = [];
  const spawner: ReexecSpawner = (file, argv, options) => {
    calls.push({ file, argv, env: options.env, stdio: options.stdio });
    const child: ReexecChild = {
      onEnd: (listener) => queueMicrotask(() => listener(code, undefined)),
      kill: () => undefined,
    };
    return child;
  };
  return { spawner, calls };
}

describe('reexecAtVersion', () => {
  // The platform is pinned: on Windows the whole command is one shell string and argv is empty
  // (a .cmd needs a shell), so asserting on argv without it passed on POSIX and failed on Windows.
  it('inherits stdio, marks the child, and exits with its code', async () => {
    const { spawner, calls } = fakeSpawner(7);
    const code = await new Promise<number>((resolve) => {
      reexecAtVersion(
        '2.14.0',
        ['mcp'],
        { PATH: '/bin' },
        { spawn: spawner, exit: resolve, platform: NodePlatform.MACOS },
      );
    });
    expect(code).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdio).toBe('inherit');
    expect(calls[0]?.argv).toContain('@reticlehq/server@2.14.0');
    expect(calls[0]?.env[VersionMatchEnv.REEXECUTED]).toBe('1');
    expect(calls[0]?.env['PATH']).toBe('/bin');
  });

  it('on Windows, runs the pinned server through a shell with the version in the command', async () => {
    const { spawner, calls } = fakeSpawner(0);
    await new Promise<number>((resolve) => {
      reexecAtVersion(
        '2.14.0',
        ['mcp'],
        { PATH: 'C:\\bin' },
        { spawn: spawner, exit: resolve, platform: NodePlatform.WINDOWS },
      );
    });
    expect(calls[0]?.file).toContain('@reticlehq/server@2.14.0');
    expect(calls[0]?.env[VersionMatchEnv.REEXECUTED]).toBe('1');
  });
});

/**
 * The MCP proxy speaks JSON-RPC over stdio, so the re-run must be invisible on the wire: the parent
 * may add nothing to stdout and drop nothing from stdin. Driven through a real parent process whose
 * spawner is redirected to a byte-echoing child — the only way to see the actual file descriptors.
 */
describe('the re-run carries the MCP stdio stream untouched', () => {
  it('passes stdin to the child and its stdout back, byte for byte', async () => {
    const echo = 'process.stdin.pipe(process.stdout)';
    const moduleUrl = new URL('./sdk-version-match.ts', import.meta.url).href;
    const parent = [
      `const { reexecAtVersion, asReexecChild } = await import(${JSON.stringify(moduleUrl)});`,
      `const { spawn } = await import('node:child_process');`,
      `reexecAtVersion('2.14.0', ['mcp'], process.env, {`,
      `  spawn: (_f, _a, o) => asReexecChild(spawn(process.execPath, ['-e', ${JSON.stringify(echo)}], o)),`,
      `  exit: (c) => process.exit(c),`,
      `  platform: 'linux',`,
      `});`,
    ].join('\n');
    const payload = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { ü: '✓' } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      'utf8',
    );
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', parent],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stdin.end(payload);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(Buffer.concat(out).equals(payload)).toBe(true);
  }, 30_000);
});

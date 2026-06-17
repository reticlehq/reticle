import { describe, expect, it } from 'vitest';
import { runInit, type InitIo, type InitOptions } from './run.js';

interface MemoryIo extends InitIo {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

interface MemoryOpts {
  execOk?: boolean;
  claudeAvailable?: boolean;
  mcpExists?: boolean;
}

function memoryIo(files: Record<string, string>, opts: MemoryOpts = {}): MemoryIo {
  const { execOk = true, claudeAvailable = true, mcpExists = false } = opts;
  const written: Record<string, string> = {};
  const lines: string[] = [];
  const execCalls: { command: string; args: readonly string[] }[] = [];
  return {
    written,
    lines,
    execCalls,
    readFile: (p) => files[p] ?? written[p] ?? null,
    writeFile: (p, c) => {
      written[p] = c;
    },
    exists: (p) => p in files || p in written,
    rootFiles: () => Object.keys(files).filter((p) => !p.includes('/')),
    exec: (command, args) => {
      execCalls.push({ command, args });
      return execOk;
    },
    probe: (_command, args) => (args.includes('get') ? mcpExists : claudeAvailable),
    print: (l) => lines.push(l),
  };
}

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: true,
  dryRun: false,
  install: false,
};

const VITE_FILES = {
  'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^19' } }),
  'vite.config.ts': `export default { plugins: [] };\n`,
};

describe('runInit', () => {
  it('errors cleanly without a package.json', () => {
    const io = memoryIo({});
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('No package.json');
  });

  it('registers iris globally via the claude CLI (not a project .mcp.json) and patches vite', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.written['.mcp.json']).toBeUndefined();
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(true);
    expect(io.written['vite.config.ts']).toContain('@syrin/iris/vite');
  });

  it('does not re-register when an iris server already exists (idempotent, install-once)', () => {
    const io = memoryIo(VITE_FILES, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude')).toBe(false);
  });

  it('prints manual global instructions when the claude CLI is missing', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(false);
    expect(io.lines.join('\n')).toContain('-s user');
  });

  it('dry run writes nothing and runs no subprocess', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit({ ...OPTS, dryRun: true }, io);
    expect(Object.keys(io.written)).toHaveLength(0);
    expect(io.execCalls).toHaveLength(0);
    expect(io.lines.join('\n')).toContain('dry run');
    expect(r.applied).toBeGreaterThan(0);
  });

  it('runs the install when enabled', () => {
    const io = memoryIo({ ...VITE_FILES, 'pnpm-lock.yaml': '' }, { mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.execCalls).toEqual([{ command: 'pnpm', args: ['add', '-D', '@syrin/iris'] }]);
  });

  it('downgrades a failed step to manual with its fallback command', () => {
    const io = memoryIo(VITE_FILES, { execOk: false, mcpExists: true });
    const r = runInit({ ...OPTS, install: true }, io);
    expect(io.lines.join('\n')).toContain('step failed — run manually');
    expect(r.manual).toBeGreaterThan(0);
  });

  it('creates app/iris-dev.tsx for a Next project', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
    });
    runInit(OPTS, io);
    expect(io.written['app/iris-dev.tsx']).toContain('IrisDev');
  });
});

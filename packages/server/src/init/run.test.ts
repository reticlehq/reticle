import { describe, expect, it } from 'vitest';
import { runInit, type InitIo, type InitOptions } from './run.js';

interface MemoryIo extends InitIo {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

function memoryIo(files: Record<string, string>, execOk = true): MemoryIo {
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

describe('runInit', () => {
  it('errors cleanly without a package.json', () => {
    const io = memoryIo({});
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('No package.json');
  });

  it('writes .mcp.json and patches the vite config for a Vite+React project', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^19' } }),
      'vite.config.ts': `import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n`,
    });
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.written['.mcp.json']).toContain('@syrin/iris');
    expect(io.written['vite.config.ts']).toContain('@syrin/iris/vite');
  });

  it('dry run writes nothing but still reports', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { vite: '^5' } }),
      'vite.config.ts': `export default { plugins: [] };\n`,
    });
    const r = runInit({ ...OPTS, dryRun: true }, io);
    expect(Object.keys(io.written)).toHaveLength(0);
    expect(io.lines.join('\n')).toContain('dry run');
    expect(r.applied).toBeGreaterThan(0);
  });

  it('runs the install when enabled', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { vite: '^5' } }),
      'pnpm-lock.yaml': '',
      'vite.config.ts': `export default { plugins: [] };\n`,
    });
    runInit({ ...OPTS, install: true }, io);
    expect(io.execCalls).toEqual([{ command: 'pnpm', args: ['add', '-D', '@syrin/iris'] }]);
  });

  it('does not run the install in dry run', () => {
    const io = memoryIo({ 'package.json': JSON.stringify({ devDependencies: { vite: '^5' } }) });
    runInit({ ...OPTS, install: true, dryRun: true }, io);
    expect(io.execCalls).toHaveLength(0);
  });

  it('downgrades the install step to manual when it fails', () => {
    const io = memoryIo(
      { 'package.json': JSON.stringify({ devDependencies: { vite: '^5' } }) },
      false,
    );
    const r = runInit({ ...OPTS, install: true }, io);
    expect(io.lines.join('\n')).toContain('install failed — run manually');
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

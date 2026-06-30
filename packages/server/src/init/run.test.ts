import { describe, expect, it } from 'vitest';
import { runInit, resolveLockfiles, type InitIo, type InitOptions } from './run.js';

interface MemoryIo extends InitIo {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

const HOME = '/home/u';

interface MemoryOpts {
  execOk?: boolean;
  claudeAvailable?: boolean;
  mcpExists?: boolean;
  cursor?: boolean;
}

function memoryIo(files: Record<string, string>, opts: MemoryOpts = {}): MemoryIo {
  const { execOk = true, claudeAvailable = true, mcpExists = false, cursor = false } = opts;
  const written: Record<string, string> = {};
  const lines: string[] = [];
  const execCalls: { command: string; args: readonly string[] }[] = [];
  // Simulate the Cursor config dir existing when requested.
  const present = { ...files };
  if (cursor) present[`${HOME}/.cursor`] = '';
  return {
    written,
    lines,
    execCalls,
    readFile: (p) => present[p] ?? written[p] ?? null,
    writeFile: (p, c) => {
      written[p] = c;
    },
    exists: (p) => p in present || p in written,
    homeDir: () => HOME,
    rootFiles: () => Object.keys(files).filter((p) => !p.includes('/')),
    exec: (command, args) => {
      execCalls.push({ command, args });
      return execOk;
    },
    probe: (_command, args) => (args.includes('get') ? mcpExists : claudeAvailable),
    print: (l) => lines.push(l),
  };
}

describe('resolveLockfiles — package-manager detection in a monorepo', () => {
  it('walks up to the workspace-root lockfile when the sub-package has none', () => {
    const io = { exists: (p: string) => p === '/repo/pnpm-lock.yaml' };
    const set = resolveLockfiles(
      new Set(['package.json', 'vite.config.ts']),
      '/repo/apps/demo',
      io,
    );
    expect(set.has('pnpm-lock.yaml')).toBe(true);
  });

  it('a local lockfile wins and short-circuits the walk', () => {
    const io = {
      exists: (): boolean => {
        throw new Error('should not walk when a local lockfile exists');
      },
    };
    const set = resolveLockfiles(new Set(['package-lock.json']), '/x/y', io);
    expect(set.has('package-lock.json')).toBe(true);
  });

  it('falls back to just the root files when no lockfile exists anywhere', () => {
    const io = { exists: (): boolean => false };
    const set = resolveLockfiles(new Set(['package.json']), '/x/y', io);
    expect([...set]).toEqual(['package.json']);
  });
});

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

  it('registers reticle globally via the claude CLI (not a project .mcp.json) and patches vite', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.written['.mcp.json']).toBeUndefined();
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(true);
    expect(io.written['vite.config.ts']).toContain('@reticlehq/core/vite');
  });

  it('does not re-register when an reticle server already exists (idempotent, install-once)', () => {
    const io = memoryIo(VITE_FILES, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude')).toBe(false);
  });

  it('prints manual global instructions when no agent is detected', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: false });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(false);
    expect(io.lines.join('\n')).toContain('-s user');
  });

  it('registers in Cursor global config when Cursor is present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: true });
    runInit(OPTS, io);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/core');
  });

  it('registers with BOTH Claude and Cursor when both are present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true, cursor: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(true);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/core');
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
    expect(io.execCalls).toEqual([{ command: 'pnpm', args: ['add', '-D', '@reticlehq/core'] }]);
  });

  it('downgrades a failed step to manual with its fallback command', () => {
    const io = memoryIo(VITE_FILES, { execOk: false, mcpExists: true });
    const r = runInit({ ...OPTS, install: true }, io);
    expect(io.lines.join('\n')).toContain('step failed — run manually');
    expect(r.manual).toBeGreaterThan(0);
  });

  it('creates app/reticle-dev.tsx for a Next project', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
    });
    runInit(OPTS, io);
    expect(io.written['app/reticle-dev.tsx']).toContain('ReticleDev');
  });

  it('creates src/hooks.client.ts for a SvelteKit project and does NOT patch vite.config', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2', vite: '^5' } }),
      'svelte.config.js': 'export default {};\n',
      'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`,
    });
    runInit(OPTS, io);
    expect(io.written['src/hooks.client.ts']).toContain('reticle.connect(');
    expect(io.written['src/hooks.client.ts']).toContain('app.html'); // explains why the hook exists
    expect(io.written['vite.config.ts']).toBeUndefined(); // the Vite plugin is NOT added for SvelteKit
  });
});

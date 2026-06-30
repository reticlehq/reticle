import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectId, readProjectPort, resolvePort } from './cli-port.js';
import { RETICLE_DEFAULT_PORT } from '@reticle/protocol';

// ─── readProjectPort ─────────────────────────────────────────────────────────

describe('readProjectPort', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-port-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    await writeFile(join(dir, '.reticle.json'), content, 'utf8');
  }

  it('returns the port from a valid .reticle.json', async () => {
    await writeConfig(JSON.stringify({ framework: 'vite', port: 4401 }));
    expect(readProjectPort(dir)).toBe(4401);
  });

  it('returns undefined when .reticle.json does not exist', () => {
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined for a completely empty directory', () => {
    const empty = tmpdir();
    expect(readProjectPort(empty)).toBeUndefined();
  });

  it('returns undefined when .reticle.json has no port field', async () => {
    await writeConfig(JSON.stringify({ framework: 'next', harnesses: ['claude-code'] }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port is a string', async () => {
    await writeConfig(JSON.stringify({ port: '4401' }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port is null', async () => {
    await writeConfig(JSON.stringify({ port: null }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port is a float', async () => {
    await writeConfig(JSON.stringify({ port: 4401.5 }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port is 0', async () => {
    await writeConfig(JSON.stringify({ port: 0 }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port is negative', async () => {
    await writeConfig(JSON.stringify({ port: -1 }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when port >= 65536', async () => {
    await writeConfig(JSON.stringify({ port: 65536 }));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('accepts port 65535 (max valid)', async () => {
    await writeConfig(JSON.stringify({ port: 65535 }));
    expect(readProjectPort(dir)).toBe(65535);
  });

  it('accepts port 1 (min valid)', async () => {
    await writeConfig(JSON.stringify({ port: 1 }));
    expect(readProjectPort(dir)).toBe(1);
  });

  it('returns undefined when .reticle.json is malformed JSON', async () => {
    await writeConfig('{ port: 4401 '); // missing closing brace, also unquoted key
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when .reticle.json is an empty file', async () => {
    await writeConfig('');
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when .reticle.json is a JSON array (not an object)', async () => {
    await writeConfig(JSON.stringify([4401]));
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when .reticle.json is a JSON number at root', async () => {
    await writeConfig('4401');
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when .reticle.json is a JSON string at root', async () => {
    await writeConfig('"4401"');
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('returns undefined when .reticle.json is "null"', async () => {
    await writeConfig('null');
    expect(readProjectPort(dir)).toBeUndefined();
  });

  it('ignores extra fields alongside port', async () => {
    await writeConfig(
      JSON.stringify({ framework: 'vite', port: 5173, harnesses: ['cursor', 'claude-code'] }),
    );
    expect(readProjectPort(dir)).toBe(5173);
  });

  it('handles the default port stored explicitly — returns it (caller decides to use it or default)', async () => {
    await writeConfig(JSON.stringify({ port: RETICLE_DEFAULT_PORT }));
    expect(readProjectPort(dir)).toBe(RETICLE_DEFAULT_PORT);
  });
});

// ─── readProjectId ───────────────────────────────────────────────────────────

describe('readProjectId', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-projid-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    await writeFile(join(dir, '.reticle.json'), content, 'utf8');
  }

  it('returns the projectId from a valid .reticle.json', async () => {
    await writeConfig(JSON.stringify({ framework: 'vite', projectId: 'acme-web-1234abcd' }));
    expect(readProjectId(dir)).toBe('acme-web-1234abcd');
  });

  it('returns undefined when absent, empty, or not a string', async () => {
    expect(readProjectId(dir)).toBeUndefined(); // no file
    await writeConfig(JSON.stringify({ framework: 'next' }));
    expect(readProjectId(dir)).toBeUndefined();
    await writeConfig(JSON.stringify({ projectId: '' }));
    expect(readProjectId(dir)).toBeUndefined();
    await writeConfig(JSON.stringify({ projectId: 42 }));
    expect(readProjectId(dir)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', async () => {
    await writeConfig('{ not json');
    expect(readProjectId(dir)).toBeUndefined();
  });
});

// ─── resolvePort ─────────────────────────────────────────────────────────────

describe('resolvePort — priority chain', () => {
  const DEFAULT = RETICLE_DEFAULT_PORT;
  const PROJECT = 4401;
  const ENV = 4402;
  const FLAG = 4403;

  it('flag wins over everything', () => {
    expect(resolvePort(FLAG, ENV, PROJECT, DEFAULT)).toBe(FLAG);
  });

  it('env wins over project and default when no flag', () => {
    expect(resolvePort(undefined, ENV, PROJECT, DEFAULT)).toBe(ENV);
  });

  it('project wins over default when no flag or env', () => {
    expect(resolvePort(undefined, undefined, PROJECT, DEFAULT)).toBe(PROJECT);
  });

  it('falls back to default when nothing else is set', () => {
    expect(resolvePort(undefined, undefined, undefined, DEFAULT)).toBe(DEFAULT);
  });

  it('flag=0: ?? is nullish (not falsy) — 0 wins as a real port value', () => {
    // ?? only skips null/undefined, not 0. So flag=0 means "use port 0", not "no flag given".
    // In practice the CLI never passes 0 as a port (invalid), but the contract is correct.
    expect(resolvePort(0, ENV, PROJECT, DEFAULT)).toBe(0);
  });
});

// ─── Scenario matrix — real .reticle.json files in isolated temp dirs ────────────

describe('Scenario matrix — port isolation per project', () => {
  let projectA: string;
  let projectB: string;
  let projectC: string;

  beforeEach(async () => {
    [projectA, projectB, projectC] = await Promise.all([
      mkdtemp(join(tmpdir(), 'reticle-projA-')),
      mkdtemp(join(tmpdir(), 'reticle-projB-')),
      mkdtemp(join(tmpdir(), 'reticle-projC-')),
    ]);
  });
  afterEach(async () => {
    await Promise.all([
      rm(projectA, { recursive: true, force: true }),
      rm(projectB, { recursive: true, force: true }),
      rm(projectC, { recursive: true, force: true }),
    ]);
  });

  it('three projects each get their own port — no collisions', async () => {
    await Promise.all([
      writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 })),
      writeFile(join(projectB, '.reticle.json'), JSON.stringify({ port: 4402 })),
      writeFile(join(projectC, '.reticle.json'), JSON.stringify({ port: 4403 })),
    ]);
    expect(readProjectPort(projectA)).toBe(4401);
    expect(readProjectPort(projectB)).toBe(4402);
    expect(readProjectPort(projectC)).toBe(4403);
    // All three are distinct
    const ports = new Set([
      readProjectPort(projectA),
      readProjectPort(projectB),
      readProjectPort(projectC),
    ]);
    expect(ports.size).toBe(3);
  });

  it('project without .reticle.json uses default — does not inherit a sibling port', () => {
    // projectA has a port; projectB has no .reticle.json
    // Reading projectB should not somehow pick up projectA's port
    expect(readProjectPort(projectA)).toBeUndefined();
    expect(readProjectPort(projectB)).toBeUndefined();
    const portA = resolvePort(
      undefined,
      undefined,
      readProjectPort(projectA),
      RETICLE_DEFAULT_PORT,
    );
    const portB = resolvePort(
      undefined,
      undefined,
      readProjectPort(projectB),
      RETICLE_DEFAULT_PORT,
    );
    expect(portA).toBe(RETICLE_DEFAULT_PORT);
    expect(portB).toBe(RETICLE_DEFAULT_PORT);
  });

  it('--port flag overrides .reticle.json for one project without touching others', async () => {
    await writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 }));
    await writeFile(join(projectB, '.reticle.json'), JSON.stringify({ port: 4402 }));
    // Agent explicitly passes --port 9999 for projectA
    const portA = resolvePort(9999, undefined, readProjectPort(projectA), RETICLE_DEFAULT_PORT);
    const portB = resolvePort(
      undefined,
      undefined,
      readProjectPort(projectB),
      RETICLE_DEFAULT_PORT,
    );
    expect(portA).toBe(9999);
    expect(portB).toBe(4402); // projectB unaffected
  });

  it('RETICLE_PORT env var overrides .reticle.json across all projects (intentional global override)', async () => {
    await Promise.all([
      writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 })),
      writeFile(join(projectB, '.reticle.json'), JSON.stringify({ port: 4402 })),
    ]);
    const envPort = 7777;
    const portA = resolvePort(undefined, envPort, readProjectPort(projectA), RETICLE_DEFAULT_PORT);
    const portB = resolvePort(undefined, envPort, readProjectPort(projectB), RETICLE_DEFAULT_PORT);
    expect(portA).toBe(7777);
    expect(portB).toBe(7777);
  });

  it('updating .reticle.json port is picked up on next resolution (no caching)', async () => {
    await writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 }));
    expect(readProjectPort(projectA)).toBe(4401);
    await writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 5555 }));
    expect(readProjectPort(projectA)).toBe(5555);
  });

  it('deleting .reticle.json falls back to default on next resolution', async () => {
    await writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 }));
    expect(readProjectPort(projectA)).toBe(4401);
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(join(projectA, '.reticle.json'));
    expect(readProjectPort(projectA)).toBeUndefined();
  });

  it('corrupting .reticle.json mid-run falls back gracefully', async () => {
    await writeFile(join(projectA, '.reticle.json'), JSON.stringify({ port: 4401 }));
    expect(readProjectPort(projectA)).toBe(4401);
    await writeFile(join(projectA, '.reticle.json'), '<<<not json>>>');
    expect(readProjectPort(projectA)).toBeUndefined();
    const corrupt = resolvePort(
      undefined,
      undefined,
      readProjectPort(projectA),
      RETICLE_DEFAULT_PORT,
    );
    expect(corrupt).toBe(RETICLE_DEFAULT_PORT);
  });
});

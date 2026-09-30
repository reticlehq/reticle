import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readJournalEnabled,
  readProjectId,
  projectIdsAt,
  readProjectPort,
  workspacePortConflict,
  projectDirOf,
  readProjectIsDesktop,
  resolvePort,
  isLikelyDevServerPort,
  devServerPortWarning,
  diagnosePortMismatch,
} from './cli-port.js';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { deriveProjectId } from '@reticlehq/init';

describe('readJournalEnabled', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-journal-cfg-'));
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('defaults to on when no config and no env', () => {
    expect(readJournalEnabled(dir, undefined)).toBe(true);
  });

  it('turns off via .reticle.json journal:false', async () => {
    await writeFile(join(dir, '.reticle.json'), JSON.stringify({ journal: false }), 'utf8');
    expect(readJournalEnabled(dir, undefined)).toBe(false);
  });

  it('env overrides config in both directions', async () => {
    await writeFile(join(dir, '.reticle.json'), JSON.stringify({ journal: false }), 'utf8');
    expect(readJournalEnabled(dir, '1')).toBe(true);
    expect(readJournalEnabled(dir, 'off')).toBe(false);
  });
});

// ─── readProjectPort ─────────────────────────────────────────────────────────

describe('readProjectPort', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-port-'));
  });
  afterEach(async () => {
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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

/**
 * The ids a directory can speak for, when the first-move instructions ask "has THIS project ever
 * connected".
 *
 * `readProjectId` only knows the id `init` wrote to `.reticle.json`. The build plugins derive the SAME
 * id from the package name and the app's root without writing that file, so a monorepo root (the app
 * is in `apps/web`) and an app wired by the plugin alone both read `undefined` there. The handshake
 * then told a working project that no app had ever connected, and told its agent to run `init`
 * again. Reported from the field, and seen on this repository.
 */
describe('projectIdsAt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-projids-'));
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), JSON.stringify(value), 'utf8');
  }

  it('is exactly the recorded id when .reticle.json names one', async () => {
    await writeJson('.reticle.json', { projectId: 'acme-web-1234abcd' });
    await writeJson('package.json', { name: 'acme' });
    expect(projectIdsAt(dir)).toEqual(['acme-web-1234abcd']);
  });

  it('includes the id the plugin derives for an app wired without init', async () => {
    await writeJson('package.json', { name: 'shop' });
    expect(projectIdsAt(dir)).toContain(deriveProjectId('shop', dir));
  });

  it('includes the ids of the workspace apps under a monorepo root', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await writeJson('apps/web/package.json', { name: '@acme/web', scripts: { dev: 'vite' } });
    await writeFile(join(dir, 'apps/web/vite.config.ts'), 'export default {}', 'utf8');
    expect(projectIdsAt(dir)).toContain(deriveProjectId('@acme/web', join(dir, 'apps/web')));
  });

  it('prefers what init recorded for a workspace app over deriving one', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await writeJson('apps/web/package.json', { name: '@acme/web', scripts: { dev: 'vite' } });
    await writeFile(join(dir, 'apps/web/vite.config.ts'), 'export default {}', 'utf8');
    await writeJson('apps/web/.reticle.json', { projectId: 'web-recorded-0000' });
    expect(projectIdsAt(dir)).toContain('web-recorded-0000');
  });

  it('is empty in a directory that is not a project at all', () => {
    expect(projectIdsAt(dir)).toEqual([]);
  });
});

/**
 * From a monorepo root whose app was wired in `apps/web`, the config walk only went UP, found
 * nothing, and every command fell back to the default port: `status`, `mcp` and `verify` talked to
 * whichever project owned that daemon. `projectIdsAt` already looked DOWN; the port now does too.
 */
describe('the port of a workspace app, read from the monorepo root', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-wsport-'));
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), JSON.stringify(value), 'utf8');
  }

  async function app(name: string, port?: number): Promise<void> {
    await writeJson(`apps/${name}/package.json`, { name, scripts: { dev: 'vite' } });
    if (port !== undefined) await writeJson(`apps/${name}/.reticle.json`, { port });
  }

  it('uses the one wired app below the root', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web', 4417);
    await app('api');
    expect(readProjectPort(dir)).toBe(4417);
    expect(workspacePortConflict(dir)).toBeUndefined();
  });

  it('picks nothing, and says so, when two wired apps disagree', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web', 4417);
    await app('admin', 4418);
    expect(readProjectPort(dir)).toBeUndefined();
    const warning = workspacePortConflict(dir) ?? '';
    expect(warning).toContain('apps/web');
    expect(warning).toContain('4417');
    expect(warning).toContain('apps/admin');
    expect(warning).toContain('4418');
  });

  it('agrees with itself when several apps share one port', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web', 4417);
    await app('admin', 4417);
    expect(readProjectPort(dir)).toBe(4417);
    expect(workspacePortConflict(dir)).toBeUndefined();
  });

  it('still prefers a config at or above the working directory', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await writeJson('.reticle.json', { port: 4499 });
    await app('web', 4417);
    await app('admin', 4418);
    expect(readProjectPort(dir)).toBe(4499);
    expect(workspacePortConflict(dir)).toBeUndefined();
  });

  it('names the directory of the project it serves', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web', 4417);
    await app('api');
    expect(projectDirOf(dir)).toBe(join(dir, 'apps/web'));
    expect(projectDirOf(join(dir, 'apps/web'))).toBe(join(dir, 'apps/web'));
  });

  // `init` writes a byte-identical copy of the app's `.reticle.json` at the root the agent runs from.
  // Finding that copy first named the ROOT as the project, so the SDK version the CLI matches itself
  // to was read from the root's node_modules — never from apps/web, where pnpm installed it.
  it('names the app, not the root, when the root holds init’s copy of the app’s config', async () => {
    const config = { projectId: 'web-abc123', port: 4417 };
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web');
    await app('api');
    await writeJson('apps/web/.reticle.json', config);
    await writeJson('.reticle.json', config);
    expect(projectDirOf(dir)).toBe(join(dir, 'apps/web'));
  });

  it('knows a desktop shell from the app it serves', async () => {
    await writeJson('package.json', { name: 'repo', workspaces: ['apps/*'] });
    await app('web', 4417);
    expect(readProjectIsDesktop(dir)).toBe(false);
    await writeJson('apps/web/package.json', {
      name: 'web',
      scripts: { dev: 'electron-vite dev' },
      devDependencies: { electron: '^34', 'electron-vite': '^2' },
    });
    expect(readProjectIsDesktop(dir)).toBe(true);
  });

  it('does not search below a directory that is not a package', async () => {
    await app('web', 4417);
    expect(readProjectPort(dir)).toBeUndefined();
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

/**
 * `.reticle.json` "port" is the BRIDGE port; the dev server's port is a different thing entirely.
 * The old setup skill asked "what port does your dev server run on?" a few lines before showing this
 * field, so the two got conflated — and the daemon then tried to bind the port the app already held.
 * The user saw a bind failure or a daemon that never connected, neither mentioning the real mistake.
 */
describe('isLikelyDevServerPort', () => {
  it('recognises the ports frameworks actually serve on', () => {
    for (const p of [3000, 5173, 4321, 8080]) expect(isLikelyDevServerPort(p)).toBe(true);
  });

  it('leaves Reticle bridge ports alone, including the multi-app range people are told to use', () => {
    for (const p of [4400, 4460, 4461, 4477]) expect(isLikelyDevServerPort(p)).toBe(false);
  });

  it('the warning names the port, the field, and the correct default', () => {
    const w = devServerPortWarning(3000);
    expect(w).toContain('3000');
    expect(w).toContain('.reticle.json');
    expect(w).toContain('4400');
  });
});

// ─── diagnosePortMismatch ───────────────────────────────────────────────────

describe('diagnosePortMismatch', () => {
  it('returns undefined when no project port is configured', () => {
    expect(diagnosePortMismatch(4400, undefined)).toBeUndefined();
  });

  it('returns undefined when the daemon port matches .reticle.json', () => {
    expect(diagnosePortMismatch(4460, 4460)).toBeUndefined();
  });

  it('returns a diagnostic when the daemon port differs from .reticle.json', () => {
    const msg = diagnosePortMismatch(4400, 4460);
    expect(msg).toBeDefined();
    expect(msg).toContain('4460');
    expect(msg).toContain('4400');
    expect(msg).toContain('.reticle.json');
  });

  it('names both the fix options: start with --port or update .reticle.json', () => {
    const msg = diagnosePortMismatch(4400, 4460);
    expect(msg).toContain('--port 4460');
    expect(msg).toContain('update .reticle.json');
  });
});

describe('finding the project config from a nested working directory', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-cfg-walk-'));
    await writeFile(
      join(root, '.reticle.json'),
      JSON.stringify({ port: 4460, projectId: 'walk-me', journal: false }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The failure this pins: every reader used to join `.reticle.json` onto cwd and stop, so a
  // process one directory away from the config was indistinguishable from a project that had never
  // been through init. An app wired in `frontend/`, an agent running from a repo root, and a
  // worktree beside its main checkout are all the same missing walk.
  it('reads port, projectId and journal from an ancestor directory', async () => {
    const nested = join(root, 'apps', 'web', 'src');
    await mkdir(nested, { recursive: true });
    expect(readProjectPort(nested)).toBe(4460);
    expect(readProjectId(nested)).toBe('walk-me');
    expect(readJournalEnabled(nested, undefined)).toBe(false);
  });

  it('prefers the nearest config, so a nested app still wins over the repo root', async () => {
    const nested = join(root, 'frontend');
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, '.reticle.json'),
      JSON.stringify({ port: 4401, projectId: 'nearest' }),
    );
    expect(readProjectPort(nested)).toBe(4401);
    expect(readProjectId(nested)).toBe('nearest');
  });

  it('does not adopt a config from an arbitrarily distant ancestor', async () => {
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    await mkdir(deep, { recursive: true });
    expect(readProjectPort(deep)).toBeUndefined();
  });

  it('walks past a malformed config rather than treating it as the answer', async () => {
    const nested = join(root, 'broken');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, '.reticle.json'), '{ not json');
    expect(readProjectPort(nested)).toBe(4460);
  });
});

/**
 * The scan states ABSENCE as a fact, so every port missing from it is a confident lie.
 *
 * `no-session-diagnosis` prints "No listener found that I can attribute to this project: the scan
 * covers …" and derives that list from this set. Run against this repository's own bench-app, which
 * serves on 4310, it reported nothing listening while the app was plainly up — the exact failure the
 * set's own comment says the additions before these were made to prevent.
 */
describe('the scanned dev-server ports cover what people actually run', () => {
  it('knows the defaults that were missing when the scan lied about an app that was running', () => {
    // 4310 is this repo's bench-app — the fixture its own agents drive, and the one that caught this.
    for (const p of [1234, 4000, 4310, 6006, 19006]) {
      expect(isLikelyDevServerPort(p), `port ${String(p)} is not scanned`).toBe(true);
    }
  });

  // The set does double duty: it also decides whether a `.reticle.json` BRIDGE port looks like a dev
  // server. Widening it must not start warning about the multi-app bridge range people are told to use.
  it('still leaves the bridge range alone after widening', () => {
    for (const p of [4400, 4460, 4461, 4477]) expect(isLikelyDevServerPort(p)).toBe(false);
  });
});

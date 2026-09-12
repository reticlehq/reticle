import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { PROJECT_REGISTRY_FILE, ReticleDir, parseProjectRegistry } from '@reticlehq/core';
import { projectIdOf, rememberProjectOnDisk, type RegistryIo } from './remember-project.js';

const HOME = '/home/dev';
const REGISTRY = join(HOME, ReticleDir.ROOT, PROJECT_REGISTRY_FILE);

function io(seed: Record<string, string> = {}): RegistryIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      files.set(path, content);
    },
    exists: (path) => files.has(path),
    homeDir: () => HOME,
  };
}

function registryIn(files: Map<string, string>) {
  return parseProjectRegistry(JSON.parse(files.get(REGISTRY) ?? '{}'));
}

describe('projectIdOf', () => {
  it('reads the id a config declares', () => {
    expect(projectIdOf('{"projectId":"acme-9f3c","port":4400}')).toBe('acme-9f3c');
  });

  /**
   * `init` runs against whatever is on disk, including a config a human edited by hand. None of
   * these shapes may throw — a registry write is a nicety and init's report is the first thing a new
   * user reads.
   */
  it('returns undefined rather than throwing on anything unusable', () => {
    expect(projectIdOf(null)).toBeUndefined();
    expect(projectIdOf('')).toBeUndefined();
    expect(projectIdOf('not json at all')).toBeUndefined();
    expect(projectIdOf('[]')).toBeUndefined();
    expect(projectIdOf('"a string"')).toBeUndefined();
    expect(projectIdOf('{"projectId":""}')).toBeUndefined();
    expect(projectIdOf('{"projectId":42}')).toBeUndefined();
    expect(projectIdOf('{}')).toBeUndefined();
  });
});

describe('rememberProjectOnDisk', () => {
  it('writes the pair into the user-level registry', () => {
    const fs = io();
    expect(rememberProjectOnDisk(fs, 'acme-9f3c', '/repo/apps/web', 1000)).toBe(true);
    expect(registryIn(fs.files).projects['acme-9f3c']).toEqual({
      directory: '/repo/apps/web',
      lastSeenAt: 1000,
    });
  });

  it('keeps projects other runs recorded', () => {
    const fs = io();
    rememberProjectOnDisk(fs, 'a-1', '/a', 1000);
    rememberProjectOnDisk(fs, 'b-2', '/b', 2000);
    expect(Object.keys(registryIn(fs.files).projects).sort()).toEqual(['a-1', 'b-2']);
  });

  /**
   * The repair case, and the reason this runs on every init rather than only the first: a project
   * that was re-cloned elsewhere and re-inited must not leave its old path behind, because two paths
   * for one id is what makes the resolver refuse to answer at all.
   */
  it('replaces a stale path when the project is re-inited somewhere new', () => {
    const fs = io();
    rememberProjectOnDisk(fs, 'acme-9f3c', '/old/clone', 1000);
    rememberProjectOnDisk(fs, 'acme-9f3c', '/new/clone', 2000);
    const projects = registryIn(fs.files).projects;
    expect(Object.keys(projects)).toEqual(['acme-9f3c']);
    expect(projects['acme-9f3c']?.directory).toBe('/new/clone');
  });

  it('starts fresh from a corrupt registry instead of failing the init', () => {
    const fs = io({ [REGISTRY]: '{ this is not json' });
    expect(rememberProjectOnDisk(fs, 'acme-9f3c', '/repo', 1000)).toBe(true);
    expect(registryIn(fs.files).projects['acme-9f3c']?.directory).toBe('/repo');
  });

  it('reports failure rather than throwing when the home directory cannot be written', () => {
    const fs: RegistryIo = {
      readFile: () => null,
      exists: () => false,
      homeDir: () => HOME,
      writeFile: () => {
        throw new Error('EROFS: read-only file system');
      },
    };
    expect(rememberProjectOnDisk(fs, 'acme-9f3c', '/repo', 1000)).toBe(false);
  });

  it('declines an empty id or directory rather than storing a useless row', () => {
    const fs = io();
    expect(rememberProjectOnDisk(fs, '', '/repo', 1000)).toBe(false);
    expect(rememberProjectOnDisk(fs, 'acme-9f3c', '', 1000)).toBe(false);
    expect(fs.files.has(REGISTRY)).toBe(false);
  });
});

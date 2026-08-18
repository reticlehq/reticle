import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverConfigs, findRepoRoot } from './config-discovery.js';

/**
 * A monorepo whose config sits under `apps/web`, which is the shape the reporter hit: the daemon is
 * started by the editor from somewhere else entirely and concludes the project is not wired.
 */
function buildMonorepo(root: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'apps', 'docs'), { recursive: true });
  mkdirSync(join(root, 'packages', 'ui'), { recursive: true });
  writeFileSync(join(root, 'apps', 'web', '.reticle.json'), '{"port":4400}');
}

describe('config discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'reticle-discovery-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds a config under apps/ when the cwd is the repo root', () => {
    buildMonorepo(tmp);

    const { configs } = discoverConfigs(tmp);

    expect(configs).toEqual([join(tmp, 'apps', 'web', '.reticle.json')]);
  });

  it('finds a config in a sibling package from inside another one', () => {
    buildMonorepo(tmp);

    const { configs } = discoverConfigs(join(tmp, 'packages', 'ui'));

    expect(configs).toContain(join(tmp, 'apps', 'web', '.reticle.json'));
  });

  it('reports every config rather than picking one', () => {
    buildMonorepo(tmp);
    writeFileSync(join(tmp, 'packages', 'ui', '.reticle.json'), '{}');

    const { configs } = discoverConfigs(tmp);

    expect(configs).toHaveLength(2);
    expect(configs).toContain(join(tmp, 'apps', 'web', '.reticle.json'));
    expect(configs).toContain(join(tmp, 'packages', 'ui', '.reticle.json'));
  });

  it('finds a config in a parent directory on the way up to the root', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    mkdirSync(join(tmp, 'src', 'admin'), { recursive: true });
    writeFileSync(join(tmp, '.reticle.json'), '{}');

    const { configs } = discoverConfigs(join(tmp, 'src', 'admin'));

    expect(configs).toEqual([join(tmp, '.reticle.json')]);
  });

  it('reports where it looked when nothing is found', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    mkdirSync(join(tmp, 'apps', 'web'), { recursive: true });

    const { configs, searched, repoRoot } = discoverConfigs(tmp);

    expect(configs).toEqual([]);
    expect(repoRoot).toBe(tmp);
    expect(searched).toContain(tmp);
    expect(searched).toContain(join(tmp, 'apps', 'web'));
  });

  it('stops at the repo root rather than walking into the user home', () => {
    buildMonorepo(tmp);

    const { searched, repoRoot } = discoverConfigs(join(tmp, 'apps', 'web'));

    expect(repoRoot).toBe(tmp);
    expect(searched.every((dir) => dir.startsWith(tmp))).toBe(true);
  });

  it('does not invent a repo root when there is no .git anywhere', () => {
    mkdirSync(join(tmp, 'loose'), { recursive: true });

    expect(findRepoRoot(join(tmp, 'loose'))).toBeUndefined();
  });

  it('still finds a config in the cwd when there is no repo around it', () => {
    writeFileSync(join(tmp, '.reticle.json'), '{}');

    const { configs, repoRoot } = discoverConfigs(tmp);

    expect(repoRoot).toBeUndefined();
    expect(configs).toEqual([join(tmp, '.reticle.json')]);
  });

  it('survives an unreadable workspace directory', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, 'apps'), 'not a directory');

    expect(() => discoverConfigs(tmp)).not.toThrow();
  });
});

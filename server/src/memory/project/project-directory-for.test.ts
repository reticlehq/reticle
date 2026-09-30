/**
 * `projectDirectoryFor` names the directory of a project this machine knows, whatever the cwd.
 *
 * The version-skew remedy reads `package.json` from wherever this points, and fell back to the
 * daemon's cwd, which for a shared daemon is often `$HOME` or a monorepo root with no app in it.
 * There it named the generic sensor package to a project that never depended on it (#1135).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_REGISTRY_FILE } from '@reticlehq/core/artifacts';
import { ReticleDir } from '@reticlehq/core';
import { sdkFixForDirectory } from '@/command/version/sdk-fix.js';
import { projectDirectoryFor } from './artifact-root-resolver.js';

let scratch: string;
let app: string;
let elsewhere: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'reticle-project-dir-'));
  const home = join(scratch, 'home');
  app = join(scratch, 'acme');
  elsewhere = join(scratch, 'daemon-cwd');
  for (const dir of [join(home, ReticleDir.ROOT), app, elsewhere])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(home, ReticleDir.ROOT, PROJECT_REGISTRY_FILE),
    JSON.stringify({ version: 1, projects: { acme: { directory: app, lastSeenAt: 1 } } }),
  );
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ dependencies: { '@reticlehq/next': '3.0.0', '@reticlehq/react': '3.0.0' } }),
  );
  writeFileSync(join(app, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('projectDirectoryFor', () => {
  it('finds a registered project from a cwd that is not it', () => {
    expect(projectDirectoryFor('acme')).toBe(app);
  });

  it('answers undefined for a project it does not know, or none', () => {
    expect(projectDirectoryFor('someone-else')).toBeUndefined();
    expect(projectDirectoryFor(undefined)).toBeUndefined();
  });

  it("is what makes the remedy name the project's own packages", () => {
    const fix = sdkFixForDirectory('3.4.0', projectDirectoryFor('acme') ?? process.cwd());

    expect(fix).toContain('@reticlehq/next');
    expect(fix).not.toContain('@reticlehq/browser');
    expect(fix).toContain('pnpm');
    // The contrast: the same question asked of the daemon's cwd, which is what it used to read.
    expect(sdkFixForDirectory('3.4.0', elsewhere)).toContain('@reticlehq/browser');
  });
});

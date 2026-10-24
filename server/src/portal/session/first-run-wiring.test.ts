import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirectoryOf } from './first-run-wiring.js';

describe('finding the unwired app a caller is in', () => {
  it('does not guess a project for a daemon in the home directory or outside any package', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const app = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }),
    );
    expect(projectDirectoryOf(home, home, () => false)).toBeUndefined();
    expect(
      projectDirectoryOf(mkdtempSync(join(tmpdir(), 'bare-')), home, () => false),
    ).toBeUndefined();
    expect(projectDirectoryOf(app, home, () => false)).toBe(app);
    // A package that is not an app (a library, an API) has no step to offer.
    const lib = mkdtempSync(join(tmpdir(), 'lib-'));
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ scripts: { dev: 'tsx watch' } }));
    expect(projectDirectoryOf(lib, home, () => false)).toBeUndefined();
    // A project that is already wired has no step to offer.
    expect(projectDirectoryOf(app, home, () => true)).toBeUndefined();
  });
});

/**
 * A daemon that cannot SEE a project can still KNOW of it.
 *
 * The no-session diagnosis learns where projects are by walking up from the daemon's cwd and across
 * the declared workspaces of whatever repo root it lands in. That walk has one blind spot, and it is
 * the most reported install problem we have: several IDEs register the MCP server GLOBALLY, so the
 * daemon starts at `/` or `$HOME`. There is nothing above `/` and no repo root at either, so the
 * walk finds nothing and the diagnosis falls through to the branches that reason from "no config
 * anywhere" — whose advice is `reticle init`.
 *
 * Reported six separate times against projects that were already correctly instrumented. One
 * reporter burned a turn re-running `init` over a working config while `doctor`, run from the app
 * directory, reported `project ✓ wired here`.
 *
 * "I am standing in the wrong place" and "you never installed this" are opposite diagnoses with
 * opposite fixes, and we were giving the second one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir, PROJECT_REGISTRY_FILE } from '@reticlehq/core';
import { registeredProjects, registeredElsewhere, isUnscopedRoot } from './registered-projects.js';
import { parse, resolve } from 'node:path';

/** The filesystem root, spelled the way this platform spells it. */
const ROOT = parse(resolve('.')).root;

let home: string;

/** Write a `~/.reticle/projects.json` holding the given projectId → directory pairs. */
function writeRegistry(projects: Record<string, string>, raw?: string): void {
  const dir = join(home, ReticleDir.ROOT);
  mkdirSync(dir, { recursive: true });
  const body =
    raw ??
    JSON.stringify({
      version: 1,
      projects: Object.fromEntries(
        Object.entries(projects).map(([id, directory]) => [id, { directory, lastSeenAt: 1 }]),
      ),
    });
  writeFileSync(join(dir, PROJECT_REGISTRY_FILE), body);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reticle-registry-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('projects this machine has paired before', () => {
  it('reads a registered project and its directory', () => {
    writeRegistry({ 'web-abc': '/repo/apps/web' });
    expect(registeredProjects(home)).toEqual([
      { projectId: 'web-abc', directory: '/repo/apps/web' },
    ]);
  });

  it('reads every registered project, not just the first', () => {
    writeRegistry({ a: '/repo/a', b: '/repo/b' });
    expect(
      registeredProjects(home)
        .map((p) => p.directory)
        .sort(),
    ).toEqual(['/repo/a', '/repo/b']);
  });

  it.each([
    ['no registry file at all', undefined],
    ['a registry that is not JSON', 'not json {'],
    ['a registry whose shape is wrong', '{"version":99,"projects":"nope"}'],
  ])('fails soft to empty on %s — a diagnosis must never throw', (_label, raw) => {
    if (raw !== undefined) writeRegistry({}, raw);
    expect(registeredProjects(home)).toEqual([]);
  });
});

describe('only a daemon parked outside every project consults the registry', () => {
  it.each([
    ['the filesystem root', () => ROOT],
    ['the user home directory', () => home],
  ])('treats %s as unscoped — an IDE global registration starts there', (_label, dir) => {
    expect(isUnscopedRoot(dir(), home)).toBe(true);
  });

  it('treats an ordinary directory as scoped, however unwired it is', () => {
    expect(
      isUnscopedRoot('/repo/apps/web', home),
      'an empty walk in a real directory still means "not wired here"',
    ).toBe(false);
  });

  it('reports a project the globally-started daemon cannot walk to', () => {
    writeRegistry({ 'web-abc': '/repo/apps/web' });
    expect(
      registeredElsewhere(home, ROOT),
      'this is the whole point: from the root the walk reaches nothing',
    ).toEqual([{ projectId: 'web-abc', directory: '/repo/apps/web' }]);
  });

  it('says NOTHING for a genuinely unwired project directory', () => {
    writeRegistry({ 'web-abc': '/repo/apps/web' });
    expect(
      registeredElsewhere(home, '/repo/apps/brand-new'),
      'every dev machine has registered projects; using them here would replace "run init" with ' +
        '"your config is elsewhere" on every new project — the opposite false negative',
    ).toEqual([]);
  });

  it('does NOT report the directory the daemon is already standing in', () => {
    writeRegistry({ home: home });
    expect(
      registeredElsewhere(home, home),
      'a correctly-scoped daemon must not be told to go look somewhere else',
    ).toEqual([]);
  });
});

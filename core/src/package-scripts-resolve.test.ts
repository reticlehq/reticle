import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every script a package.json runs must name a file that exists.
 *
 * `prepack` is the one that hurts, and it is the one nothing could see. Five packages ran
 * `node ../../scripts/prepare-dist.mjs` — correct while they lived one directory below the root,
 * and wrong the moment they moved into `adapters/<kind>/<name>`. Nothing failed: `build` is `tsc`
 * and does not touch it, `verify` never packs, and the battery never publishes. The first thing to
 * notice was the install gate, fifteen minutes in, and only because it packs the repository for
 * real. On a release day it would have been the release.
 *
 * This is the same rot as a harness naming a built file that has moved, and it is checked the same
 * way and for the same reason: a relative path in a string is invisible to every compiler, and a
 * directory move is exactly when they all go wrong at once.
 *
 * Only RELATIVE paths are checked. A bare command is a PATH or bin-shim question, which is a
 * different failure with a different fix.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();

/** Relative script paths a command names — `../x.mjs`, `./tools/y.sh`. */
const RELATIVE_SCRIPT = /(\.\.?\/[A-Za-z0-9._/-]+\.(?:mjs|js|cjs|sh))/g;

function manifests(): string[] {
  return execFileSync('git', ['ls-files', '*package.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('node_modules'));
}

function scriptsOf(manifest: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, manifest), 'utf8'));
  if (typeof parsed !== 'object' || null === parsed || !('scripts' in parsed)) return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || null === scripts) return {};
  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).filter(
      (entry): entry is [string, string] => 'string' === typeof entry[1],
    ),
  );
}

/**
 * A `ln -s` target is resolved by the LINK's directory, not the manifest's.
 *
 * The root's git-hook install symlinks `../../pre-commit.sh` into `.git/hooks/`, where it resolves
 * correctly. Read as a path from the repository root it does not exist, and calling that broken
 * would be this check being confidently wrong about the one manifest it was written to protect.
 */
function isSymlinkTarget(command: string): boolean {
  return /\bln\s+-[a-z]*s/.test(command);
}

describe('a package.json never runs a script that is not there', () => {
  const found = manifests();

  it('finds manifests to check (a passing test over zero files proves nothing)', () => {
    expect(found.length).toBeGreaterThan(10);
  });

  it.each(found)('%s names only scripts that exist', (manifest) => {
    const dir = path.dirname(path.join(REPO_ROOT, manifest));
    const missing: string[] = [];
    for (const [name, command] of Object.entries(scriptsOf(manifest))) {
      if (isSymlinkTarget(command)) continue;
      for (const match of command.matchAll(RELATIVE_SCRIPT)) {
        const spec = match[1];
        if (spec === undefined) continue;
        if (!existsSync(path.resolve(dir, spec))) missing.push(`${name}: ${spec}`);
      }
    }
    expect(
      missing,
      `${manifest} runs scripts that do not exist. If this is prepack, the package cannot be ` +
        'published and no build, test or battery will ever say so.',
    ).toEqual([]);
  });
});

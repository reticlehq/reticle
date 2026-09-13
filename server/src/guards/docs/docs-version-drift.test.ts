/**
 * The docs must not claim a version the packages do not have.
 *
 * Every release bumps ten packages in lockstep, and every release leaves the version behind in the
 * places that are not `package.json`: a "Version X" line on each package page, a "ten packages ship
 * together at X" claim, a pinned `npm i -D @reticlehq/react@X` in the install pages, and a CDN import
 * pinned to X in the SKILL file. That last one is the expensive one, because a reader who copies it
 * pins their page SDK to a version the daemon has moved past, which is the `version_skew` failure
 * arriving by way of a stale doc.
 *
 * Caught the release it was written for: the bump landed and eleven files still said the previous
 * version, including the CDN pin. Nothing failed, because nothing was looking.
 *
 * Deliberately NOT a blanket ban on the old version string. `CHANGELOG.md` is a history and must
 * keep every version it ever shipped, and a doc may legitimately name an older release when it is
 * describing when something changed. The rule is narrower: where a doc states THE CURRENT version,
 * it has to be the current version.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_VERSION } from '../../command/version/identity/server-version.js';
import { REPO_ROOT } from '../../machine/repo-root.js';

const REPO = REPO_ROOT;
const DOCS = join(REPO, 'docs');

/**
 * Files that state the current version, and are read by someone about to install.
 *
 * Every path here must EXIST. The list used to name `skills/reticle/SKILL.md`, which has not existed
 * for a long time, and the loop below swallowed the read error and moved on — so the guard listed a
 * file it never opened and reported green for it. A registry whose entries are never checked is the
 * failure this repo keeps rediscovering, and a version guard that reads as coverage while checking
 * nothing is worse than no guard at all.
 */
const VERSION_BEARING = [
  join(REPO, 'SKILL.md'),
  join(REPO, 'README.md'),
  join(DOCS, 'packages.mdx'),
  join(DOCS, 'install-agentic.mdx'),
  join(DOCS, 'docs.json'),
];

const packagePages = (): string[] => {
  const dir = join(DOCS, 'packages');
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
};

/**
 * Claims of a CURRENT version, as opposed to a mention of some version.
 *
 * Each pattern is a shape that means "this is what you get today": a package page's version line,
 * the lockstep claim, a pinned install, the CDN import, and the docs site's own version field.
 */
const CURRENT_VERSION_CLAIMS: readonly RegExp[] = [
  /\*\*Version (\d+\.\d+\.\d+)\./g,
  /ship together at the same version, all at \*\*(\d+\.\d+\.\d+)\*\*/g,
  /@reticlehq\/[a-z-]+@(\d+\.\d+\.\d+)/g,
  /"version":\s*"(\d+\.\d+\.\d+)"/g,
];

/** Read a file this guard claims to check. A missing one is a bug in the list, not a passing check. */
const readVersionBearing = (file: string): string => {
  if (!existsSync(file))
    throw new Error(
      `${file.replace(REPO, '.')} is listed as version-bearing but does not exist. Remove it from ` +
        `VERSION_BEARING, or point it at the file that replaced it — an entry nobody can read is a ` +
        `check that silently does not run.`,
    );
  return readFileSync(file, 'utf8');
};

/** Every current-version claim in the checked files, with the file that makes it. */
const versionClaims = (): { file: string; claimed: string }[] => {
  const out: { file: string; claimed: string }[] = [];
  for (const file of [...VERSION_BEARING, ...packagePages()]) {
    const text = readVersionBearing(file);
    for (const pattern of CURRENT_VERSION_CLAIMS) {
      for (const match of text.matchAll(pattern)) {
        const claimed = match[1];
        if (claimed !== undefined) out.push({ file, claimed });
      }
    }
  }
  return out;
};

describe('the docs do not advertise a version the packages do not have', () => {
  it('finds files to check', () => {
    expect(packagePages().length).toBeGreaterThan(5);
  });

  it('every version-bearing file exists and is readable', () => {
    for (const file of VERSION_BEARING) expect(() => readVersionBearing(file)).not.toThrow();
  });

  /**
   * A version guard that matches nothing passes forever.
   *
   * When this was written, five of the six files it listed matched zero patterns and the sixth
   * carried the only live assertion, so a rename of `docs.json`'s version field — or a rewrite of the
   * install pages into a shape these patterns do not recognise — would have left a green test
   * watching nothing. The guard has to be able to FIRE, so it asserts it found something to judge
   * before judging it.
   */
  it('finds at least one current-version claim to check', () => {
    expect(
      versionClaims().length,
      'no file matched any CURRENT_VERSION_CLAIMS pattern, so this guard is checking nothing. ' +
        'Either the docs stopped stating a current version, or they state it in a new shape and ' +
        'the pattern list needs it.',
    ).toBeGreaterThan(0);
  });

  it('every current-version claim matches the shipped version', () => {
    const wrong = versionClaims()
      .filter((c) => c.claimed !== SERVER_VERSION)
      .map((c) => `${c.file.replace(REPO, '.')}: claims ${c.claimed}`);

    expect(
      [...new Set(wrong)],
      `These state a current version that is not the shipped one (${SERVER_VERSION}). A release ` +
        `bumps package.json and leaves these behind, and the CDN pin in the SKILL file is the ` +
        `expensive one: a reader who copies it pins their page SDK to a version the daemon has ` +
        `moved past.`,
    ).toEqual([]);
  });
});

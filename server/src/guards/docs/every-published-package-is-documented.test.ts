import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * A package somebody can install has a section on the page that explains the packages.
 *
 * `docs/packages.mdx` is where a reader goes to find out what the `@reticlehq/*` names are and
 * which ones they need. Nothing kept it in step with what is actually published, so v3 added
 * two packages to npm — `@reticlehq/openreality`, the specification itself, and
 * `@reticlehq/engine`, the rules that decide a verdict — and neither appeared on it. The
 * protocol is the headline of the release and the page listing the packages did not know it
 * existed.
 *
 * Nothing else covers this. The payload guard checks what a tarball contains, the licence guard
 * checks what it ships beside the code, the version guards check the numbers agree. All three
 * are about the artifact. This is about whether a person can find out the artifact exists.
 *
 * Publishability is read from the manifests, so adding a package is enough to be asked for; and
 * the crate is checked too, because `reticle-tauri` is installable and is not an npm package.
 *
 * README is deliberately NOT checked the same way, and the reason is worth keeping. Its
 * "What's inside" table had the identical hole and both new packages were added to it by hand.
 * But the table groups the three build plugins into one row and writes them `-next`,
 * `-babel-plugin`, `-eslint-plugin` with the prefix elided, and `@reticlehq/init` is never
 * named at all because nobody installs it. A guard insisting on the full name of every package
 * would force that table apart to satisfy a check rather than to help a reader, which is the
 * thing a guard is supposed to prevent, not cause. Discoverability is covered by the page
 * whose job it is.
 */

const PAGE = 'docs/packages.mdx';

/** Every workspace package that npm would accept. `apps/` are local fixtures and never ship. */
function publishedNames(): string[] {
  const manifests = execFileSync('git', ['ls-files', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path && !path.startsWith('apps/'));
  const names: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as {
      private?: boolean;
      name?: string;
    };
    if (true === manifest.private) continue;
    if (undefined !== manifest.name) names.push(manifest.name);
  }
  return names.sort();
}

/** The Rust crate, which is published to crates.io and has no package.json. */
const CRATE = 'reticle-tauri';

function documentedNames(): string[] {
  const page = readFileSync(join(REPO_ROOT, PAGE), 'utf8');
  return [...page.matchAll(/^## (@reticlehq\/[a-z-]+|reticle-tauri)\s*$/gm)]
    .map((match) => match[1] ?? '')
    .sort();
}

describe('what a reader can find out exists', () => {
  it('reads both lists, so a pass is not a pass over nothing', () => {
    // If either side silently returned nothing, the comparison below would be empty-to-empty.
    expect(publishedNames().length).toBeGreaterThan(8);
    expect(documentedNames().length).toBeGreaterThan(8);
  });

  it(`gives every published package a section in ${PAGE}`, () => {
    const expected = [...publishedNames(), CRATE].sort();
    const missing = expected.filter((name) => !documentedNames().includes(name));
    expect(
      missing,
      `these are published and have no section in ${PAGE}. Somebody can install them and has ` +
        'nowhere to read what they are for.',
    ).toEqual([]);
  });

  it(`documents nothing in ${PAGE} that is not published`, () => {
    // The other direction: a section for a package that was renamed or unpublished sends a
    // reader to an npm name that does not resolve.
    const expected = new Set([...publishedNames(), CRATE]);
    const phantom = documentedNames().filter((name) => !expected.has(name));
    expect(
      phantom,
      `${PAGE} has a section for these and nothing publishes them. A reader following the name ` +
        'finds nothing on npm.',
    ).toEqual([]);
  });
});

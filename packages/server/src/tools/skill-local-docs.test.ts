import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A page SKILL.md says is "on disk beside this file" has to actually be there.
 *
 * The skill file tells an agent it can open some pages locally instead of fetching them. That is
 * worth saying: a field install lost two minutes to repeated web fetches, and the page an agent
 * reaches for most is the troubleshooting one -- read at the moment something is already not
 * working, which is the worst moment to depend on the network.
 *
 * The promise is only as good as the path. `docs/` is at the repository root here and at
 * `packages/server/docs` in the published package, the extensions are a mix of `.md` and `.mdx`, and
 * `pack-docs.mjs` copies rather than renames. A path that is right in one of those places and wrong
 * in the other fails in the copy every user downloads, and silently -- the agent simply fetches
 * instead, or gives up on the page entirely.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SKILL = join(REPO_ROOT, 'SKILL.md');

/** Every `docs/...` path SKILL.md names as available on disk. */
function localDocPaths(): string[] {
  const text = readFileSync(SKILL, 'utf8');
  return [
    ...new Set([...text.matchAll(/`(docs\/[\w./-]+\.mdx?)`/g)].map((m) => m[1] ?? '')),
  ].sort();
}

describe('the local copies SKILL.md promises are real', () => {
  const paths = localDocPaths();

  it('names at least one', () => {
    // Without this the check below would pass by having nothing to look for.
    expect(paths.length).toBeGreaterThan(0);
  });

  it('every one exists', () => {
    expect(
      paths.filter((path) => !existsSync(join(REPO_ROOT, path))),
      'SKILL.md tells an agent these ship on disk beside it, and they do not exist. Either fix the ' +
        'path (mind .md against .mdx) or stop promising the local copy.',
    ).toEqual([]);
  });

  it('and is published, so the promise holds in the tarball too', () => {
    // The repository is not the thing the promise is made to. `files` in the manifest decides what a
    // user actually receives, and a page that exists here and ships nowhere is the same broken
    // promise arriving by a different route.
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'server', 'package.json'), 'utf8'),
    ) as { files?: string[] };
    expect(manifest.files ?? []).toContain('docs');
  });
});

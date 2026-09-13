import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * A source path named in the docs points at a file that is there.
 *
 * Seven directories moved under `adapters/` and every document naming one kept the old path.
 * The layout map at the top of CLAUDE.md was the loudest case; the quiet ones were nine pages
 * telling a reader to look in `packages/server/src/...`, a directory that has not existed for
 * two releases. Nothing goes red for this. A path in a document is a string, and the person it
 * misleads is never the person who broke it.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, because every one of these is correct as written:
 *
 *   - the reader's own app. `src/main.tsx`, `app/reticle-dev.tsx`, `pages/_app.tsx` and their
 *     kind name files in the project somebody is instrumenting, not files here.
 *   - CHANGELOG.md, which is a record of what was true at the time. Repointing an old entry
 *     at a path invented later would make the history less accurate, not more.
 *   - docs/matrix/, which is a dated capture of a past release.
 *   - anything under plan/, which is gitignored.
 *
 * The exclusion list is the interesting part of this guard and the part most likely to rot, so
 * it is a named constant rather than a regex buried in a filter.
 */

const NOT_OUR_TREE = [/^src\//, /^app\//, /^pages\//, /^specs\//, /^reticle-fixtures\//, /^dist\//];

const DOCUMENTS_THAT_RECORD_THE_PAST = ['CHANGELOG.md'];

/**
 * Two documents with the same defect, excluded rather than fixed.
 *
 * `docs/telemetry-contract.md` and `docs/telemetry-events.mdx` name eight paths that do not
 * resolve, several of them under the dead `packages/` prefix. They are not excluded because
 * they are correct. They are excluded because telemetry is owned by somebody else in this
 * repository and editing their documents to satisfy a guard I wrote is not mine to do.
 *
 * This entry is a handoff, not an absolution: delete it and fix the paths in the same commit,
 * whoever gets there first.
 */
const OWNED_ELSEWHERE = ['docs/telemetry-contract.md', 'docs/telemetry-events.mdx'];

/** Backtick-quoted strings shaped like a path to a source file in this repository. */
const PATH_LIKE = /`([A-Za-z0-9_][\w./-]*\/[\w./-]*\.(?:ts|tsx|mjs|mts|cjs|rs))`/g;

function documents(): string[] {
  return execFileSync('git', ['ls-files', '*.md', '*.mdx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path)
    .filter((path) => !path.startsWith('docs/matrix/'))
    .filter((path) => !DOCUMENTS_THAT_RECORD_THE_PAST.includes(path))
    .filter((path) => !OWNED_ELSEWHERE.includes(path));
}

/**
 * True when the path resolves somehow.
 *
 * Documents write paths three ways and all three are legitimate: from the repository root,
 * relative to the document, and relative to the package the document lives in (a README inside
 * `engine/` naming `window/engine-host.ts` means `engine/src/window/engine-host.ts`).
 */
function resolves(document: string, path: string): boolean {
  const here = dirname(document);
  const pkg = here.split('/')[0] ?? '';
  const candidates = [
    path,
    join(here, path),
    '' === pkg ? path : join(pkg, path),
    '' === pkg ? path : join(pkg, 'src', path),
  ];
  return candidates.some((candidate) => existsSync(join(REPO_ROOT, candidate)));
}

function danglingPaths(): string[] {
  const dangling: string[] = [];
  for (const document of documents()) {
    const text = readFileSync(join(REPO_ROOT, document), 'utf8');
    for (const match of text.matchAll(PATH_LIKE)) {
      const path = match[1];
      if (undefined === path) continue;
      if (path.includes('node_modules')) continue;
      if (NOT_OUR_TREE.some((pattern) => pattern.test(path))) continue;
      if (resolves(document, path)) continue;
      dangling.push(`${document} names ${path}`);
    }
  }
  return [...new Set(dangling)].sort();
}

describe('source paths named in the documentation', () => {
  it('finds paths to check, so a pass is not a pass over nothing', () => {
    // A tightened regex or an over-eager exclusion would empty this and the check below would
    // pass over no paths at all.
    let counted = 0;
    for (const document of documents()) {
      counted += [...readFileSync(join(REPO_ROOT, document), 'utf8').matchAll(PATH_LIKE)].length;
    }
    expect(counted).toBeGreaterThan(100);
  });

  it('all point at files that exist', () => {
    expect(
      danglingPaths(),
      'these documents send a reader to a file that is not there. A path in prose is a string: ' +
        'moving the file breaks nothing and tells nobody, and the person misled is never the ' +
        'person who moved it.',
    ).toEqual([]);
  });
});

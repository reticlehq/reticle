import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Each release is written down once, under its own heading.
 *
 * A merge, a revert or a restore-from-tag can leave two `## [X.Y.Z]` headings in this file, and
 * everything downstream keeps working: the sibling freshness guard counts commits since the
 * file was last touched, the docs-drift guard reads version strings, and neither looks at the
 * shape. So the duplicate sits there, and whoever cuts the release reads the first section they
 * find.
 *
 * That is not hypothetical. Restoring the published 2.14.0 section from its tag during a
 * fifty-eight-commit merge left TWO `## [2.14.0] — 2026-09-10` headings, and the first of them
 * carried eighteen bullets of v3 work — a whole release filed under the previous release's
 * number, with the real 2.14.0 sitting underneath it unchanged. Every gate was green. It was
 * found by reading the file, which is not a strategy.
 *
 * Two things are checked, and neither needs to know what a release contains. A version appears
 * at most once. And the versions run newest-first, because a section that arrives out of order
 * is the other shape this failure takes — an old heading re-added below where it belongs reads
 * as history rather than as a mistake.
 */

const CHANGELOG = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

/** `## [1.2.3] — date`, `## [1.2.3]`, and `## [Unreleased]`. */
const HEADING = /^## \[([^\]]+)\]/gm;

function headings(): string[] {
  return [...CHANGELOG.matchAll(HEADING)].map((match) => match[1] ?? '');
}

/** [1, 2, 3] from "1.2.3"; null for Unreleased or anything else not a version. */
function asVersion(name: string): readonly number[] | null {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (null === parts) return null;
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Negative when a is older than b. */
function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

describe('the changelog is shaped like a changelog', () => {
  it('has headings to check, so a pass is not a pass over nothing', () => {
    // A regex that stopped matching would find no duplicates and no disorder, and both
    // assertions below would pass over an empty list.
    expect(headings().length).toBeGreaterThan(5);
    expect(headings()).toContain('Unreleased');
  });

  it('writes each version down exactly once', () => {
    const seen = new Map<string, number>();
    for (const name of headings()) seen.set(name, (seen.get(name) ?? 0) + 1);
    const repeated = [...seen].filter(([, count]) => 1 < count).map(([name]) => name);
    expect(
      repeated.sort(),
      'these versions have more than one section. Whoever cuts the release reads the first one ' +
        'they find, and the other is invisible — which is how a whole release once ended up ' +
        "filed under the previous release's number.",
    ).toEqual([]);
  });

  it('lists the versions newest first', () => {
    const versions = headings()
      .map((name) => ({ name, parts: asVersion(name) }))
      .filter((entry): entry is { name: string; parts: readonly number[] } => null !== entry.parts);
    const wrong: string[] = [];
    for (let i = 1; i < versions.length; i += 1) {
      const above = versions[i - 1];
      const below = versions[i];
      if (undefined === above || undefined === below) continue;
      if (0 >= compare(above.parts, below.parts))
        wrong.push(`${above.name} is above ${below.name}`);
    }
    expect(
      wrong,
      'a version section is out of order. Read downwards the file should go newest to oldest; ' +
        'an old heading sitting below where it belongs reads as history rather than as the ' +
        'mistake it is.',
    ).toEqual([]);
  });
});

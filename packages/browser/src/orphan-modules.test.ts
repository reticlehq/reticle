import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * This test does not ban orphans. It requires every deliberate orphan to be named with the reason
 * it remains, and fails when a production module becomes unreachable without that decision.
 */

const SRC = join(__dirname);

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {
  'presenter/presenter-test-helpers.ts':
    'Test-only DOM and presenter builders shared by presenter specs. Production code has no ' +
    'reason to import test fixture construction.',
  'test-support/array-at.ts':
    "Test-only `Array.prototype.at` replacement (ES2022 API removed from this package's ES2017 " +
    'lib) shared by specs across observers/transport/recorder/actions. Production code indexes ' +
    'arrays directly and has no reason to import it.',
};

/** Source files, excluding tests, type-only barrels and the entry points everything hangs off. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test-harness.ts')) continue;
    acc.push(relative(SRC, full).split(sep).join('/'));
  }
  return acc;
}

/** Entry points and barrels are imported by consumers outside src, so "no importer here" is expected. */
const ENTRY_POINTS = new Set(['index.ts']);

describe('no undeclared orphan modules', () => {
  const files = sourceFiles(SRC);
  const corpus = files.map((file) => ({
    path: file,
    text: readFileSync(join(SRC, file), 'utf8'),
  }));

  it('every module without a production importer is declared, with a reason', () => {
    const orphans: string[] = [];
    for (const file of files) {
      if (ENTRY_POINTS.has(file)) continue;
      const base = file.replace(/\.ts$/, '');
      const specifier = `${base.split('/').pop() ?? base}.js`;
      const imported = corpus.some(
        (candidate) =>
          candidate.path !== file &&
          !candidate.path.endsWith('.test.ts') &&
          candidate.text.includes(specifier),
      );
      if (!imported && DECLARED_UNWIRED[file] === undefined) orphans.push(file);
    }
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    const stale: string[] = [];
    for (const declared of Object.keys(DECLARED_UNWIRED)) {
      const specifier = `${declared.replace(/\.ts$/, '').split('/').pop() ?? ''}.js`;
      const imported = corpus.some(
        (candidate) =>
          candidate.path !== declared &&
          !candidate.path.endsWith('.test.ts') &&
          candidate.text.includes(specifier),
      );
      if (imported) stale.push(declared);
    }
    expect(stale).toEqual([]);
  });
});

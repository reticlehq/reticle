import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { importsOf, reachableFrom, resolveImport } from './import-graph.js';

/**
 * The free build must never reach the paid code.
 *
 * `packages/server/src/ee/` holds enterprise features and carries its own licence (see
 * `ee/README.md`). Everything else in this repo is open source. That difference is the entire reason
 * the directory exists, and until now it was written down only in prose — no check enforced it.
 *
 * It held so far for an accidental reason: nothing in production imports `ee/` yet, so there was
 * nothing to catch. That stops being true the moment the first real enterprise feature lands, and by
 * then the wrong import is already shipped and someone has to unpick it.
 *
 * What a broken boundary actually costs:
 *
 *  - Someone running the open-source build gets code they were never given a licence for.
 *  - The open-source build stops being complete on its own, which is the promise that makes an open
 *    core honest.
 *  - Removing the paid part later stops being a delete and becomes a refactor.
 *
 * So the rule is checked from both front doors of this package: `index.ts`, which a program imports
 * to embed the engine, and `cli.ts`, which is the `reticle` command a person runs. If neither can
 * reach `ee/`, the free build cannot contain it.
 */

const SRC = __dirname;

/** The directory holding separately-licensed code. Any module under it is off limits to the free build. */
const PAID_DIRECTORY = 'ee/';

/** The two ways anything outside this package gets in. If a rule holds at both, it holds. */
const FREE_ENTRY_POINTS = ['index.ts', 'cli.ts'];

/** Modules under the paid directory that `entry` can reach, each with the module that pulled it in. */
function paidModulesReachableFrom(entry: string): string[] {
  const reachedVia = reachableFrom(SRC, entry);
  return [...reachedVia.entries()]
    .filter(([file]) => file.startsWith(PAID_DIRECTORY))
    .map(([file, importer]) => `${file} (imported by ${importer})`)
    .sort();
}

describe('the free build cannot reach the separately-licensed code', () => {
  for (const entry of FREE_ENTRY_POINTS) {
    it(`${entry} does not reach ${PAID_DIRECTORY}`, () => {
      expect(paidModulesReachableFrom(entry)).toEqual([]);
    });
  }

  /**
   * The negative control, and the reason to trust the two tests above.
   *
   * A guard that has never been seen to fail is not a guard, it is a hope. The paid directory is
   * empty of production callers today, so both tests above would pass on a walker that was silently
   * broken and returned nothing at all. This proves the walker really does find a module under the
   * paid directory when a path to one exists — by walking from a module inside it.
   */
  it('finds paid modules when a path to one really exists (negative control)', () => {
    const fromInside = paidModulesReachableFrom(join(PAID_DIRECTORY, 'audit-log.ts'));
    expect(fromInside.length).toBeGreaterThan(0);
    expect(fromInside.join(' ')).toContain('audit-log.ts');
  });

  /**
   * The paid code may still use the open-source engine — that direction is fine and expected. Only
   * the reverse is forbidden. Stated as a test so nobody "fixes" the rule by making it symmetric.
   */
  it('the paid code is allowed to import the free code', () => {
    const auditLogImports = importsOf(SRC, join(PAID_DIRECTORY, 'audit-log.ts'));
    const reachesFreeCode = auditLogImports
      .map((specifier) => resolveImport(join(PAID_DIRECTORY, 'audit-log.ts'), specifier))
      .some((target) => target !== undefined && !target.startsWith(PAID_DIRECTORY));
    expect(reachesFreeCode).toBe(true);
  });
});

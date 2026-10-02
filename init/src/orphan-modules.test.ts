import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * Added with the last two packages that had no orphan guard. Zero today in both, measured rather
 * than assumed -- and the measurement is only trustworthy because the shared scanner was fixed
 * first: it could not read a wildcard `exports` subpath, and reported every module a package
 * publishes by pattern as unreachable.
 */

const PACKAGE_DIR = join(__dirname, '..');

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {};

describe('no undeclared orphan modules', () => {
  const { orphans, stale } = scanPackage(PACKAGE_DIR, DECLARED_UNWIRED);

  it('every module without a production importer is declared, with a reason', () => {
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    expect(stale).toEqual([]);
  });
});

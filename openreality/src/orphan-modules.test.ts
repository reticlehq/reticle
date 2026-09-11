import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * The stakes are different here than in a product package. This one is published so that people
 * outside this repository can implement the protocol, and a vocabulary file that nothing reaches
 * is not merely dead weight — it is a piece of specification that the reference implementation
 * does not actually use, shipped as though it did. That is the failure this whole release has
 * been finding in other forms: `impeaching`, `predicate` and `Ground` were each defined,
 * deferred to somebody, and evaluated by nobody, and each made a clause of the adjudicator
 * unreachable. A file nobody imports is the same defect one level up.
 *
 * Zero today, measured rather than assumed.
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

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * Five packages had this and the two newest did not. `@reticlehq/engine` is the one that most
 * needed it: nine thousand lines lifted out of the server in a single refactor, and a carve-out
 * is precisely where dead code appears — a file that had one importer in its old home can arrive
 * with none in the new one, compile, publish, and be found years later.
 *
 * Measured before it was written, which is the only reason it is a guard rather than a cleanup:
 * one file looked unreferenced, `question/predicate-asks.ts`, and it is not. `server` imports it
 * three times through the `./question/*.js` subpath in this package's `exports` map.
 *
 * That subpath is also why the shared scanner had to be fixed before this file could be honest.
 * It mapped `"./dist/question/*.js"` to the literal candidate `question/*.ts`, which matches no
 * file, so the first run reported SEVENTEEN orphans — every module `server` imports by name
 * every day. `entryPoints` expands export patterns now. A guard whose first result is seventeen
 * findings is usually wrong about the question rather than right about the code.
 *
 * One consequence worth knowing: this package publishes four directories by pattern, so any file
 * added to them is public API by the manifest's own account and can never be an orphan here.
 * That is the manifest's claim, not a weakening of the guard — narrow the `exports` map if it
 * stops being true.
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

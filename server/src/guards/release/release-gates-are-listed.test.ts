import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../repo-root.js';

/**
 * Every gate is either in the release checklist or deliberately not, with a reason.
 *
 * `RELEASING.md` is the document somebody follows while cutting a release, and it is the only
 * release artifact no gate executes. It listed five commands while the repository had eight
 * gates, and the two missing ones were the two this release exists for: `gate:conformance`,
 * the only check that this implementation still answers its own published specification, and
 * `test:e2e:desktop`, the only one that starts a desktop runtime. `gate:install` was absent
 * too, which is the gate whose absence let a release ship a Next.js install that connected 0%
 * of the time.
 *
 * A checklist that names five gates out of eight quietly narrows what "all gates green" means,
 * and nothing noticed for as long as both lists were maintained by hand.
 *
 * So the gates are read from `package.json` and each must be accounted for. Adding a gate now
 * fails this test, and the fix is a decision: put it in the checklist, or say here why a
 * release does not need it.
 */

const RELEASING = join(REPO_ROOT, 'RELEASING.md');

/**
 * Scripts that are gates, from the manifest rather than a list.
 *
 * `verify` is excluded because the checklist spells out its four parts instead of calling it,
 * which is deliberate: `format:check` has to run first and be seen to.
 */
function gateScripts(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    readonly scripts?: Record<string, string>;
  };
  return Object.keys(manifest.scripts ?? {})
    .filter((k) => /^(gate:|test:e2e)/.test(k))
    .filter((k) => !/:self-test$|:self-check$|:record$/.test(k))
    .sort();
}

/** Gates a release does not need to run, each with the reason it is safe to skip. */
const NOT_A_RELEASE_GATE: Record<string, string> = {
  'gate:multi':
    'a multi-agent simulation that measures behaviour under concurrent drivers. It reports, it ' +
    'does not pass or fail, so there is nothing for a release to read from it.',
  'gate:soak':
    'a long-running stability probe. Useful before a risky change and far too slow to sit on ' +
    'the release path, where its failure mode would be somebody skipping it and saying they ran it.',
};

describe('the release checklist names every gate, or says why not', () => {
  it('finds the gates and the document, so a pass is not a pass over nothing', () => {
    expect(gateScripts().length).toBeGreaterThan(3);
    expect(readFileSync(RELEASING, 'utf8')).toContain('pnpm format:check');
  });

  it('accounts for every gate', () => {
    const doc = readFileSync(RELEASING, 'utf8');
    const unaccounted = gateScripts().filter(
      (g) => !doc.includes(`pnpm ${g}`) && NOT_A_RELEASE_GATE[g] === undefined,
    );
    expect(
      unaccounted,
      'A gate exists that the release checklist neither runs nor excuses. Add it to the gate ' +
        'block in RELEASING.md, or to NOT_A_RELEASE_GATE here with the reason a release can ' +
        'skip it. A checklist shorter than the gate list narrows what "all gates green" means.',
    ).toEqual([]);
  });

  it('has no stale exclusion', () => {
    // The other direction: a gate that has since been added to the checklist must leave the
    // exclusion list, or the list stops reading as a set of decisions.
    const doc = readFileSync(RELEASING, 'utf8');
    const contradictory = Object.keys(NOT_A_RELEASE_GATE).filter((g) => doc.includes(`pnpm ${g}`));
    expect(contradictory).toEqual([]);
  });

  it('excuses nothing that is not a gate', () => {
    // A typo in the exclusion list would silently excuse a gate that still exists under its
    // real name, which is the failure this whole test is about.
    const gates = gateScripts();
    for (const named of Object.keys(NOT_A_RELEASE_GATE)) {
      expect(gates, `${named} is excused and is not a gate script`).toContain(named);
    }
  });
});

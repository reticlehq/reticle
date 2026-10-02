/**
 * The protocol package is the one artifact that must NOT move with the release train.
 *
 * `crate-version-lockstep.test.ts` next door makes lockstep a fact for the twelfth artifact. This
 * is the same question answered the other way for the thirteenth, and the reason is that
 * `open-verification` is not ours in the way the rest are: it carries no scope on npm because it is
 * the specification, published so that somebody other than us can implement it.
 *
 * It did ride the train, because `scripts/set-version.mjs` reaches every manifest in the tree. The
 * package was created at `2.14.0` — the monorepo's version that day, not a history it had — rode to
 * `3.1.0`, and published one prerelease claiming two majors of breaking changes to a JS API that
 * had never shipped at all. `OVP_VERSION` stood at `1.0` the whole time and the schema `$id` said
 * `/schema/v1`. Nothing was broken by it, which is why nothing caught it: a version is a claim
 * about history, and an inherited one is a claim nobody made on purpose.
 *
 * On a specification, that number is the first thing an implementer reads about maturity. So the
 * package is excluded from the lockstep (`NOT_LOCKSTEPPED` in `scripts/set-version.mjs`) and its
 * major tracks the specification's. This is what stops the next `set-version` run from quietly
 * putting it back.
 *
 * It pins the MAJOR only. The distribution is free to move at its own pace — a breaking change to
 * the published JS API is still a package major even with the specification standing still, which
 * is exactly what the four numbers in `open-verification/VERSIONING.md` exist to keep apart.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVP_VERSION } from 'open-verification';
import { REPO_ROOT } from '@/machine/repo-root.js';

function manifestVersion(pkgDir: string): string {
  const raw = readFileSync(join(REPO_ROOT, pkgDir, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const version =
    'object' === typeof parsed && null !== parsed
      ? (parsed as Record<string, unknown>)['version']
      : undefined;
  if ('string' !== typeof version) throw new Error(`${pkgDir} has no version field`);
  return version;
}

/** The leading integer of a dotted version, which is all this rule is about. */
function major(version: string): string {
  const first = version.split('.')[0];
  if (undefined === first || '' === first) throw new Error(`no major in "${version}"`);
  return first;
}

describe('open-verification versions against the spec, not against this repo', () => {
  it('reads real versions from both sides, so this cannot pass on two absences', () => {
    // The negative control. Both values are derived, and derived values can agree by being equally
    // empty — which is how a guard like this passes for the wrong reason.
    expect(manifestVersion('open-verification')).toMatch(/^\d+\.\d+\.\d+/);
    expect(OVP_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it('shares a major with OVP_VERSION', () => {
    const pkg = manifestVersion('open-verification');
    expect(
      major(pkg),
      `open-verification is ${pkg} while the protocol is ${OVP_VERSION}. A release bump reached ` +
        'it: add it back to NOT_LOCKSTEPPED in scripts/set-version.mjs. See VERSIONING.md.',
    ).toBe(major(OVP_VERSION));
  });

  it('does not simply equal the monorepo version, which is what going wrong looked like', () => {
    // Not a style rule: the failure mode was the two being identical BECAUSE one script wrote both.
    // If the spec ever legitimately reaches the repo's number this needs a human, not a silent pass.
    expect(manifestVersion('open-verification')).not.toBe(manifestVersion('.'));
  });
});

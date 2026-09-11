import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Every scoped package says out loud that it publishes publicly.
 *
 * npm's default access for a SCOPED name is restricted. A package without
 * `publishConfig.access: "public"` is therefore asking to be published private, and on its FIRST
 * publish that is either a 402 or a package nobody outside the org can install. Ten of the
 * thirteen here said `public`; `@reticlehq/openreality`, `@reticlehq/engine` and
 * `@reticlehq/electron` did not.
 *
 * The first two are new in this release, which is exactly when it matters: an existing package
 * inherits the access it already has on the registry, so `electron` would have survived on
 * momentum and the two new ones would not. The protocol package — the whole point of the
 * release, the thing other people are meant to implement against — was set to publish where
 * nobody could read it.
 *
 * Nothing else could see this. The payload guard reads what goes INTO the tarball, the licence
 * guard what ships beside it, the version guards that the numbers agree. Access is not in the
 * tarball at all; it is an argument to the publish, and the only way to observe it without
 * publishing is `npm publish --dry-run`, which prints "with tag latest and public access" or
 * "default access" and is not run by any gate. Found by running it.
 */

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: unknown;
  readonly homepage?: unknown;
  readonly bugs?: unknown;
  readonly description?: unknown;
  readonly engines?: unknown;
  readonly license?: unknown;
}

/**
 * What an npm page needs to be worth landing on.
 *
 * Every one of the eleven packages that existed before v3 carries all of these. Neither of the
 * two the release adds did: no repository link, so the npm page has no source and provenance
 * has nothing to point at; no `bugs`, so a reader with a problem has nowhere to go; no
 * `keywords`, which for a specification package whose entire purpose is being found and
 * implemented by other people is most of the job.
 *
 * The same shape as the access defect one commit earlier, and the same cause: a new package
 * does not inherit the conventions of its neighbours, and nothing was comparing them.
 */
const PAGE_FIELDS = [
  'repository',
  'homepage',
  'bugs',
  'description',
  'engines',
  'license',
] as const;

function publishable(): { path: string; manifest: Manifest }[] {
  return execFileSync('git', ['ls-files', '*/package.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => '' !== path && !path.startsWith('apps/'))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as Manifest,
    }))
    .filter(({ manifest }) => true !== manifest.private && undefined !== manifest.name);
}

describe('what a scoped package asks npm for', () => {
  it('finds the publishable packages, so a pass is not a pass over none', () => {
    expect(publishable().length).toBeGreaterThan(8);
  });

  it('every published package carries the fields an npm page needs', () => {
    const thin = publishable()
      .map(({ manifest }) => ({
        name: manifest.name ?? '',
        missing: PAGE_FIELDS.filter((field) => undefined === manifest[field]),
      }))
      .filter(({ missing }) => 0 < missing.length)
      .map(({ name, missing }) => `${name} lacks ${missing.join(', ')}`)
      .sort();
    expect(
      thin,
      'these publish to npm with nothing on the page: no source link, nowhere to report a bug, ' +
        'or no statement of what they are. Copy the shape from any neighbour.',
    ).toEqual([]);
  });

  it('every scoped one declares public access', () => {
    const restricted = publishable()
      .filter(({ manifest }) => (manifest.name ?? '').startsWith('@'))
      .filter(({ manifest }) => 'public' !== manifest.publishConfig?.access)
      .map(({ manifest }) => manifest.name ?? '')
      .sort();
    expect(
      restricted,
      'these are scoped and do not declare publishConfig.access "public". npm defaults a scoped ' +
        'name to RESTRICTED, so a first publish is a 402 or a package nobody can install. An ' +
        'already-published package inherits its access and hides this until the next new one.',
    ).toEqual([]);
  });
});

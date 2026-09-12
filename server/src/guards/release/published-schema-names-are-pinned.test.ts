import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The filenames two packages publish as `schema/*.json`, and the `$id` inside each one.
 *
 * `@reticlehq/openreality` and `@reticlehq/core` both export `"./schema/*.json"`. That makes every
 * emitted filename a public entry point, exactly like the source filenames pinned in
 * `public-subpaths-are-pinned.test.ts` -- and that file deliberately excludes JSON, because it pins
 * SOURCE filenames and these are generated. The exclusion is right and left this surface with
 * nothing watching it at all.
 *
 * These names are load-bearing twice over. `openreality/README.md` tells an implementer: "JSON
 * Schema for every noun, generated from the source. Implement in any language by validating against
 * these; you need none of this code." Somebody taking that offer writes the filename down. And each
 * openreality schema carries `$id: https://openreality.dev/schema/v1/<name>.json`, which is the
 * identifier a validator dereferences and another document `$ref`s. The generator already says so
 * next to the constant -- "Stable: a moved schema url is a broken contract" -- and an intention
 * written in a comment is not a check.
 *
 * Renaming a key in the generator's `SCHEMAS` map changes both at once, and nothing goes red: the
 * build regenerates happily under the new name, the wildcard export keeps resolving, every test
 * passes, and the breakage is entirely on the other side of the package boundary. Same shape as the
 * move that was reverted out of `engine/src/evidence`, one level further out -- there the public
 * name was at least a file somebody could see in the source tree. Here it does not exist until the
 * generator runs.
 *
 * Adding a noun is a new public entry point; renaming or removing one is a breaking change. Both
 * are fine deliberately: update the list below in the same commit, and name the old identifier and
 * the new one in the changelog.
 */

interface SchemaSurface {
  readonly package: string;
  /** The `$id` prefix every file must carry, or undefined when the package emits none. */
  readonly idBase: string | undefined;
  readonly files: readonly string[];
}

const PINNED: readonly SchemaSurface[] = [
  {
    package: 'openreality',
    idBase: 'https://openreality.dev/schema/v1',
    files: [
      'action-receipt.json',
      'action.json',
      'anomaly.json',
      'assertion.json',
      'belief.json',
      'blind-spot.json',
      'capability.json',
      'channel-descriptor.json',
      'claim.json',
      'constraint-violation.json',
      'constraint.json',
      'coverage.json',
      'evidence.json',
      // New public entry point: the reference to state a suite starts from. An implementer in
      // another language validates a saved fixture against this by name.
      'fixture-ref.json',
      'flow.json',
      'handle.json',
      'implementation.json',
      'intent.json',
      'invalidation.json',
      'match.json',
      'observation.json',
      'predicate.json',
      'provenance.json',
      'repair.json',
      'subject-ref.json',
      'verdict-record.json',
      'verification-run.json',
      'window.json',
    ],
  },
  {
    // Core's wire schemas are published the same way and carry no `$id` at all, so only the
    // filenames are a promise here. Stated rather than assumed: the first draft of this guard
    // asserted an id base for both and went red on the package that never had one.
    package: 'core',
    idBase: undefined,
    files: [
      'command-message.json',
      'command-name.json',
      'command-result.json',
      'event-message.json',
      'event-payloads.json',
      'event-type.json',
      'hello-message.json',
      'reticle-event.json',
      'reticle-message.json',
    ],
  },
];

const dirFor = (pkg: string): string => join(REPO_ROOT, pkg, 'dist', 'schema');

describe('what the protocol publishes by filename', () => {
  it.each(PINNED.map((s) => s.package))(
    '%s has been built, so nothing below reads an empty directory',
    (pkg) => {
      // Without this the equality below would compare [] against the pinned list and fail with a
      // confusing diff, or -- if the list were ever emptied too -- pass over nothing.
      expect(existsSync(dirFor(pkg)), `${dirFor(pkg)} is missing — run pnpm build`).toBe(true);
      expect(readdirSync(dirFor(pkg)).length).toBeGreaterThan(5);
    },
  );

  it.each(PINNED)('$package emits exactly the schema files it has promised', (surface) => {
    expect(
      readdirSync(dirFor(surface.package))
        .filter((name) => name.endsWith('.json'))
        .sort(),
      `The published schema filenames of @reticlehq/${surface.package} changed. Each one is a ` +
        'public entry point through its `./schema/*.json` export, and an implementer in another ' +
        'language was invited to validate against it by name. Adding one: append it here. ' +
        'Renaming or removing one: a breaking change — update this list in the same commit and ' +
        'name the old identifier and the new one in the changelog.',
    ).toEqual([...surface.files].sort());
  });

  it.each(PINNED.filter((s) => s.idBase !== undefined))(
    '$package stamps every schema with the identifier it published',
    (surface) => {
      for (const name of surface.files) {
        const schema = JSON.parse(
          readFileSync(join(dirFor(surface.package), name), 'utf8'),
        ) as Record<string, unknown>;
        expect(
          schema['$id'],
          `${name} carries the wrong $id. This is the URL a validator dereferences and another ` +
            'document $refs; moving it breaks every consumer silently.',
        ).toBe(`${String(surface.idBase)}/${name}`);
      }
    },
  );
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ovp from './index.js';

/**
 * `SPEC.md` is the normative document, so every value the vocabulary defines must appear in it.
 *
 * Everything else in this package has been checked in one direction: does the code reach what it
 * declares. This is the other direction, and it had never been checked at all. **Twelve values
 * existed in the code and were named nowhere in the specification** — including all six
 * `BlindSpotKind`s, so an implementer working from `SPEC.md` alone could not have known that
 * `still-in-flight` exists, which is the one that makes the coverage clause fire.
 *
 * The consequence is specific to this package. Elsewhere a stale document is a nuisance; here it
 * is the product. `SPEC.md` and the generated JSON Schemas are the whole of what somebody gets
 * who does not install the TypeScript, and a vocabulary value the document never mentions is a
 * value they will not implement.
 *
 * Matching is token-bounded rather than a substring. `includes('net')` is satisfied by the word
 * "network", and the first version of this measurement passed `bound` on the word "bounded" --
 * a check that cannot tell a term from a coincidence would have reported this file as clean.
 */

const SPEC = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'openreality/SPEC.md',
);

/** Every const-enum this package exports, as name -> its string values. */
function vocabularies(): [string, string[]][] {
  return Object.entries(ovp)
    .filter(
      ([, value]) =>
        null !== value &&
        'object' === typeof value &&
        !('parse' in (value as object)) &&
        Object.values(value as object).length > 0 &&
        Object.values(value as object).every((v) => 'string' === typeof v),
    )
    .map(([name, value]) => [name, Object.values(value as Record<string, string>)]);
}

/** Does the document use this exact term, rather than merely contain its letters? */
function namesTerm(document: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${term}([^a-z0-9-]|$)`).test(document);
}

describe('the specification names everything the vocabulary defines', () => {
  it('finds vocabularies and a document, so a passing run cannot mean it read nothing', () => {
    expect(vocabularies().length).toBeGreaterThan(8);
    expect(readFileSync(SPEC, 'utf8').length).toBeGreaterThan(10_000);
  });

  it('mentions every value of every exported vocabulary', () => {
    const document = readFileSync(SPEC, 'utf8');
    const unnamed = vocabularies().flatMap(([name, values]) =>
      values.filter((v) => !namesTerm(document, v)).map((v) => `${name}.${v}`),
    );
    expect(
      unnamed,
      'these values exist in the vocabulary and SPEC.md never names them, so an implementation ' +
        'written from the specification would not produce them. Document each, or remove it ' +
        'from the vocabulary.',
    ).toEqual([]);
  });
});

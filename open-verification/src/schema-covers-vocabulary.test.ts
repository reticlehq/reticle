import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSchemas, SCHEMAS } from '../scripts/gen-schema.mjs';
import * as ovp from './index.js';

/**
 * The JSON Schemas are the contract for everybody who does not install this package.
 *
 * `SPEC.md` says the schemas "are the language-neutral form of the same contract, so an
 * implementation in another language needs none of this code". That is the promise this package
 * exists to keep, and nothing checked it: the generator reads a hand-written map, and a noun
 * added to the vocabulary without a line in that map simply never reaches the contract. The
 * TypeScript would have it, every JSON consumer would not, and both would look fine.
 *
 * It had already happened three times before this test existed. `Handle` -- what `locate()`
 * returns, and the reason a handle is safer than a selector -- had no schema at all, so an
 * implementer working from JSON could not have built `locate`. `Invalidation`, which a verdict
 * cites when a subject's identity dies, had none either. `Match` was the third.
 *
 * The rule below is deliberately structural rather than a list. A protocol NOUN is a zod object:
 * the enums, unions and branded strings are vocabulary *within* the nouns and are inlined into
 * them by the generator. So "every exported object schema is published" is checkable without an
 * exemption list, and an exemption list is what this repository has learned to distrust -- it is
 * the mechanism by which the next omission excuses itself.
 */

/** Every object schema this package exports: the protocol's nouns. */
function exportedNouns(): string[] {
  return Object.entries(ovp)
    .filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodObject)
    .map(([name]) => name)
    .sort();
}

/** `SubjectRefSchema` -> `subject-ref`, which is how the generator names its files. */
function fileNameOf(exportName: string): string {
  return exportName
    .replace(/Schema$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

describe('the JSON contract covers the vocabulary', () => {
  it('finds nouns to check, so a passing run cannot mean it read nothing', () => {
    expect(exportedNouns().length).toBeGreaterThan(20);
  });

  it('publishes a JSON Schema for every noun the package exports', () => {
    const published = new Set(Object.keys(SCHEMAS));
    const missing = exportedNouns()
      .map(fileNameOf)
      .filter((name) => !published.has(name));
    expect(
      missing,
      'these are exported as zod objects and have no JSON Schema, so an implementation working ' +
        'from the published contract cannot see them. Add each to SCHEMAS in ' +
        'scripts/gen-schema.mjs.',
    ).toEqual([]);
  });

  it('emits every schema it names, and each one carries its identifier', () => {
    // The generator could silently produce nothing for an entry; a reader would find an absent
    // file rather than a wrong one, which is the failure that looks like "not implemented yet".
    const built = buildSchemas();
    for (const name of Object.keys(SCHEMAS)) {
      expect(built[name], `${name} is named in SCHEMAS and produced no schema`).toBeDefined();
      expect(built[name]?.$id, `${name} has no $id`).toContain(name);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A rule the published JSON Schema cannot carry is a rule other languages do not get.
 *
 * `gen-schema.mjs` states the direction of authority in its own header: "the TypeScript is the
 * AUTHORING form and the JSON Schema is the CONTRACT". Everything in this package is written
 * for an implementer who never installs it and reads `schema/*.json` instead.
 *
 * `zod-to-json-schema` cannot express a `.refine()`. It emits the object and drops the
 * predicate, silently and with no warning, so a conditional MUST enforced here is simply absent
 * there — `required` does not list the field and no `if`/`then` appears. Two such rules exist
 * today and BOTH were added in this release:
 *
 *   - a match may not rest on `valueContains` alone (predicate.ts)
 *   - an abandoned intent must record why (intent.ts)
 *
 * Neither is a mistake to have made — they are real rules and enforcing them in the authoring
 * form is better than not enforcing them at all. What would be a mistake is believing they are
 * published. This test makes the gap countable: every refinement must appear below with the
 * spec sentence that carries it, so a reader of the JSON Schema alone can be pointed at prose
 * for the part the machine-readable form drops.
 *
 * Asserted by equality. Adding a refinement fails this test, which is the moment to decide
 * whether to model it as a discriminated union the generator CAN express, or to add it here.
 */

const SRC = join(__dirname);
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: SRC,
  encoding: 'utf8',
}).trim();

/** Files carrying a `.refine()`, as paths relative to the package. */
function filesWithRefinements(): string[] {
  const out = execFileSync('git', ['grep', '-l', '--', '.refine(', 'openreality/src'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((f) => '' !== f && !f.endsWith('.test.ts'))
    .sort();
}

/**
 * Every refinement, and the SPEC.md sentence a reader of the JSON Schema must be sent to.
 *
 * The spec text is quoted rather than cited by line number, because a line number is a fact
 * about today's file and this list has to survive an edit above it.
 */
const KNOWN = [
  {
    file: 'openreality/src/vocabulary/intent.ts',
    rule: 'an abandoned intent must record why',
    specSays: 'the reason MUST be recorded',
  },
  {
    file: 'openreality/src/vocabulary/predicate.ts',
    rule: 'a match may not rest on valueContains alone',
    specSays: 'valueContains',
  },
];

describe('rules the JSON Schema cannot carry are named rather than assumed published', () => {
  it('finds the refinements, so an empty answer cannot mean it read nothing', () => {
    expect(filesWithRefinements().length).toBeGreaterThan(0);
  });

  it('has an entry for every refinement in the package, and no stale ones', () => {
    expect(filesWithRefinements()).toEqual(KNOWN.map((k) => k.file).sort());
  });

  it('points each one at prose that actually exists in the specification', () => {
    const spec = readFileSync(join(REPO, 'openreality', 'SPEC.md'), 'utf8');
    for (const entry of KNOWN) {
      expect(spec.includes(entry.specSays), `SPEC.md never says "${entry.specSays}"`).toBe(true);
    }
  });
});

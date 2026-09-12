import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No rule in this package may be expressed as a `.refine()`, because the contract cannot carry one.
 *
 * `gen-schema.mjs` states the direction of authority in its own header: "the TypeScript is the
 * AUTHORING form and the JSON Schema is the CONTRACT". Everything here is written for an
 * implementer who never installs this package and reads `schema/*.json` instead.
 *
 * `zod-to-json-schema` cannot express a refinement. It emits the object and discards the
 * predicate, silently and with no warning -- `required` does not grow, no `if`/`then` appears.
 * So a conditional MUST written as a `.refine()` is enforced for people who install the
 * TypeScript and absent for everybody the contract exists to serve. For a rule about
 * PORTABILITY, which both of this release's were, that is most of the way to not having it.
 *
 * Both were rewritten as unions, which the generator CAN express:
 *
 *   match.json   anyOf, required: ['summary', 'valueContains']  — a match may not rest on a
 *                substring alone
 *   intent.json  anyOf, required: ['status', 'abandonedBecause'] — an abandoned intent must
 *                record why
 *
 * If a future rule genuinely cannot be shaped as a union, this test is where the divergence gets
 * declared -- with the spec sentence that carries it, so a reader of the JSON Schema alone can
 * be pointed at prose for the part the machine-readable form drops. An empty list is the goal,
 * not the assumption.
 */

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();

/**
 * Source with comments stripped, because the first version of this guard was GREEN on three
 * comment lines and zero real refinements.
 *
 * It matched the prose explaining why these are unions rather than refinements — including
 * prose written in the same commit that removed the last refinement. A guard that reads its own
 * explanation as the thing it forbids reports the opposite of the truth, and this repository has
 * a note about that exact failure from a previous occurrence.
 */
function code(file: string): string {
  return readFileSync(join(REPO, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'openreality/src'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** Refinements that genuinely cannot be a union, each with the spec sentence carrying it. */
const DECLARED_DIVERGENCES: { readonly file: string; readonly specSays: string }[] = [];

describe('every published rule survives the trip to JSON Schema', () => {
  it('reads the source, so an empty answer cannot mean it read nothing', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);
    // The stripper must not eat the code along with the comments.
    expect(code('openreality/src/vocabulary/intent.ts')).toContain('discriminatedUnion');
    // ...and it must actually strip: this phrase exists only inside a comment block.
    expect(code('openreality/src/vocabulary/intent.ts')).not.toContain('quietly stopped moving');
  });

  it('has no refinement that is not a declared divergence', () => {
    const found = sourceFiles().filter((f) => code(f).includes('.refine('));
    expect(found.sort()).toEqual(DECLARED_DIVERGENCES.map((d) => d.file).sort());
  });

  it('points each declared divergence at prose that exists in the specification', () => {
    const spec = readFileSync(join(REPO, 'openreality', 'SPEC.md'), 'utf8');
    for (const entry of DECLARED_DIVERGENCES) {
      expect(spec.includes(entry.specSays), `SPEC.md never says "${entry.specSays}"`).toBe(true);
    }
  });

  it('the two rules that were refinements are in the published schemas now', () => {
    // The point of the rewrite, asserted against the generated artefact rather than the source.
    for (const name of ['match', 'predicate', 'intent']) {
      const schema = readFileSync(
        join(REPO, 'openreality', 'dist', 'schema', `${name}.json`),
        'utf8',
      );
      expect(schema, `${name}.json carries no conditional requirement`).toMatch(
        /"required":\s*\[\s*"(summary|status)",\s*"(valueContains|abandonedBecause)"\s*\]/,
      );
    }
  });
});

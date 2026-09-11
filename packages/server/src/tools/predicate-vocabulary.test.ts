/**
 * An agent can only use a predicate kind it knows exists.
 *
 * Reported from the field on 2026-08-10:
 *
 * > reticle_assert route predicate rejected urlContains (unrecognized_keys) while net predicate
 * > accepts urlContains. Skill examples use route without documenting fields; I assumed parallel
 * > URL filters. Need: which field names a route change after login?
 *
 * The agent was right that it was undocumented. `reticle_assert`'s `predicate` description read
 * "{ signal }, { net }, { element } or a combination" and **did not mention `route` at all** — even
 * though "did submitting the login form navigate away" is the single most common thing an agent
 * wants to assert. It recovered by spending a `reticle_tools` round trip; `reticle_tools` is
 * re-called on 33% of its uses across the whole export, which is what "I do not know the grammar"
 * looks like from the outside.
 *
 * Same shape as `query-strategy.test.ts`, which asserts the query description names every `by`
 * strategy: the schema is the source of truth, and guidance that omits part of it is a defect the
 * schema cannot catch.
 */

import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

/**
 * Combinators are grammar, not vocabulary — an agent reaches for `allOf` only once it already has
 * two predicates to combine, and naming them in the same breath as the kinds reads as noise.
 */
const COMBINATORS = new Set<string>([
  PredicateKind.ALL_OF,
  PredicateKind.ANY_OF,
  PredicateKind.NOT,
]);

function predicateGuidance(toolName: string): string {
  const tool = TOOLS.find((t) => t.name === toolName);
  expect(tool, `${toolName} is not on the surface`).toBeDefined();
  const schema = tool?.inputSchema as Record<string, { description?: string }> | undefined;
  const fields = ['predicate', 'until'];
  const described = fields.map((f) => schema?.[f]?.description ?? '').join(' ');
  return `${tool?.description ?? ''} ${described}`;
}

describe('the predicate vocabulary is discoverable from the tool that takes it', () => {
  for (const kind of Object.values(PredicateKind)) {
    if (COMBINATORS.has(kind)) continue;
    it(`reticle_assert names the '${kind}' predicate`, () => {
      expect(
        predicateGuidance(ReticleTool.ASSERT),
        `an agent reading reticle_assert has no way to learn '${kind}' exists, so it will either ` +
          'not use it or guess at its spelling — which is how a field report reached us.',
      ).toContain(kind);
    });
  }
});

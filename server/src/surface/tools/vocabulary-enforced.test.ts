import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';

/**
 * A parameter that ADVERTISES a vocabulary must ENFORCE it.
 *
 * `reticle_query.by` was declared `z.string()` while its description said
 * "role | text | label | placeholder | testid | alt". So `by:'css'` — the first thing anyone
 * arriving from Playwright types — sailed past the schema, missed every arm of the browser's
 * switch, and came back as `{ count: 0 }`. Against a live page with a <body>. An agent reads that
 * as "the element is not there" and reports the app is fine: a false green Reticle invented.
 *
 * The audit that found it turned up five more of the same shape, so this is the general rule rather
 * than a second patch. Any parameter whose description lists alternatives with `|` must reject a
 * value outside that list at the schema, which is the cheapest place to say no and the only one
 * that cannot be bypassed by a caller reaching the tool another way.
 *
 * If a new parameter trips this, the fix is a `z.enum` derived from the vocabulary's enum in core —
 * never a hand-retyped list, which is how the query description came to omit `component`.
 */
describe('no tool parameter advertises a vocabulary it does not enforce', () => {
  /** "role | text | testid", "error | warn | info" — a list of alternatives written in prose. */
  const ADVERTISES_VOCABULARY = /(?:^|[\s(:])[a-z_]{2,}(?:\s*\|\s*[a-z_]{2,}){1,}/;
  const OUT_OF_VOCABULARY = 'definitely-not-a-valid-value-xyz';

  const offenders = TOOLS.flatMap((tool) =>
    Object.entries(tool.inputSchema ?? {})
      .filter(([, schema]) => {
        const described = schema?.description ?? '';
        if (!ADVERTISES_VOCABULARY.test(described)) return false;
        return true === schema?.safeParse(OUT_OF_VOCABULARY).success;
      })
      .map(([param]) => `${tool.name}.${param}`),
  );

  it('holds for every advertised vocabulary', () => {
    expect(offenders, `these accept any string: ${offenders.join(', ')}`).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { QueryBy } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

/**
 * An unsupported query strategy must be REFUSED, never answered with zero matches.
 *
 * `by` was declared `z.string()`, so any value the browser's switch does not recognise fell through
 * its `default: return []`. Measured against a live page that visibly had all of them:
 *
 *   by:'css'   value:'body'   -> { count: 0 }
 *   by:'css'   value:'input'  -> { count: 0 }
 *   by:'css'   value:'*'      -> { count: 0 }
 *
 * Zero is the single most dangerous answer this product can give. `css` is the first thing anyone
 * arriving from Playwright or Testing Library reaches for, and the reply is indistinguishable from
 * "the element is genuinely not on the page" — an agent then reports the app is fine. That is a
 * false green manufactured by Reticle itself, which is the exact failure it exists to prevent.
 *
 * The description also hand-listed the strategies and had already drifted: it omitted `component`,
 * which is in the enum and works.
 */
describe('reticle_query — an unknown strategy is refused, not answered with zero', () => {
  const query = TOOLS.find((t) => t.name === ReticleTool.QUERY);

  it('exists', () => {
    expect(query).toBeDefined();
  });

  it('constrains `by` to the QueryBy vocabulary instead of any string', () => {
    const schema = query?.inputSchema['by'];
    expect(schema).toBeDefined();
    for (const valid of Object.values(QueryBy)) {
      expect(schema?.safeParse(valid).success, `should accept '${valid}'`).toBe(true);
    }
  });

  it.each([['css'], ['xpath'], ['selector'], ['test-id'], ['Role']])(
    'rejects %s at the schema, so it can never reach the empty-result path',
    (bad) => {
      expect(query?.inputSchema['by']?.safeParse(bad).success).toBe(false);
    },
  );

  it('still allows `by` to be omitted — the predicate spelling does not use it', () => {
    expect(query?.inputSchema['by']?.safeParse(undefined).success).toBe(true);
  });

  it('names the valid strategies from the enum rather than a hand-copied list', () => {
    // The old description listed six and omitted `component`, which is real and works. A vocabulary
    // retyped in prose drifts from the one the code enforces; this is the repo's own rule.
    for (const valid of Object.values(QueryBy)) {
      expect(query?.description, `description must mention '${valid}'`).toContain(valid);
    }
  });
});

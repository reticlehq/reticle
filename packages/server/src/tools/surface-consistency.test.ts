/**
 * One concept, one spelling — across the whole tool surface.
 *
 * Three separate first-call rejections were found in a single night's driving, every one of them the
 * same shape: a concept with two names on neighbouring tools.
 *
 *   reticle_act_and_wait { until }  vs  reticle_wait_for / reticle_assert { predicate }
 *   reticle_annotate     { flow }   vs  reticle_flow_save / _replay / flow { flowName }
 *   reticle_query        { by,value } vs every predicate's { testid | text | role }
 *
 * They matter far out of proportion to their size. Of the 25 sessions that called any tool in a day,
 * 13 made exactly ONE call and stopped — so a call rejected on spelling is a session that never comes
 * back, and the rejection says nothing to distinguish "you named it wrong" from "the app is broken".
 *
 * Prose cannot hold this line: the surface is assembled from a dozen modules and nobody sees two
 * spellings of one idea unless they happen to read both files. So it is a test. Adding a tool that
 * speaks half a synonym group fails here, with the fix named.
 */

import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';

/**
 * Names that mean the same thing to a caller. Every tool accepting ANY member must accept them ALL,
 * so an agent that learned one spelling from a neighbouring tool is never rejected for it.
 *
 * Add a group when a concept legitimately acquires a second name — never to paper over a tool that
 * should simply have used the existing one.
 */
interface SynonymGroup {
  readonly names: readonly string[];
  /**
   * Tools where one of these names means something ELSE, with the reason. An exception must be
   * justified here rather than silently omitted — otherwise the guard erodes into a list of things
   * somebody once found inconvenient.
   */
  readonly except?: Readonly<Record<string, string>>;
}

const SYNONYM_GROUPS: readonly SynonymGroup[] = [
  {
    // The predicate to wait for / assert. `until` is act_and_wait's name for it.
    names: ['predicate', 'until'],
    /**
     * `until` is OVERLOADED on this surface, and these are the tools where it is not a predicate.
     *
     * The read family — observe / network / console — uses `until` as a NUMBER: an upper cursor
     * bound, "the span between action A and B". The act/assert family uses it for a predicate. Same
     * token, different type, six tools. Aliasing cannot fix that; only renaming can, and renaming a
     * shipped parameter is a breaking change. Recorded here so the split is deliberate and visible
     * rather than a thing each reader rediscovers.
     */
    except: {
      reticle_observe: 'until is a numeric cursor bound, not a predicate',
      reticle_network: 'until is a numeric cursor bound, not a predicate',
      reticle_console: 'until is a numeric cursor bound, not a predicate',
    },
  },
  {
    // Which recorded flow an operation targets.
    names: ['flow', 'flowName'],
  },
];

describe('every tool speaks the whole synonym group, not half of it', () => {
  for (const group of SYNONYM_GROUPS) {
    it(`{ ${group.names.join(' | ')} } is accepted wherever any of it is`, () => {
      const offenders: string[] = [];
      for (const tool of TOOLS) {
        if (group.except?.[tool.name] !== undefined) continue;
        const keys = new Set(Object.keys(tool.inputSchema));
        const present = group.names.filter((name) => keys.has(name));
        if (0 === present.length) continue;
        const missing = group.names.filter((name) => !keys.has(name));
        if (missing.length > 0) {
          offenders.push(
            `${tool.name} accepts ${present.join('/')} but not ${missing.join('/')} — ` +
              `an agent that learned "${missing[0]}" from a neighbouring tool is rejected here`,
          );
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('the registry itself is well formed', () => {
    // A one-name group guards nothing; a name in two groups makes the rule ambiguous.
    const seen = new Set<string>();
    const toolNames = new Set(TOOLS.map((t) => t.name));
    for (const group of SYNONYM_GROUPS) {
      expect(group.names.length, `group ${group.names.join('/')} needs two names`).toBeGreaterThan(
        1,
      );
      // An exception naming a tool that no longer exists is stale cover for a rule nobody rechecked.
      for (const [tool, why] of Object.entries(group.except ?? {})) {
        expect(toolNames.has(tool), `exception names a tool that is gone: ${tool}`).toBe(true);
        expect(why.length, `exception for ${tool} needs a reason`).toBeGreaterThan(10);
      }
      for (const name of group.names) {
        expect(seen.has(name), `'${name}' appears in two groups`).toBe(false);
        seen.add(name);
      }
    }
  });
});

/**
 * The query shape is not a rename but a different SHAPE — strategy+value versus named fields — so it
 * cannot be expressed as a synonym group. Pinned separately: the fields the predicate teaches must
 * stay callable on reticle_query.
 */
describe('reticle_query keeps accepting the predicate spelling', () => {
  const query = TOOLS.find((t) => 'reticle_query' === t.name);

  it.each(['testid', 'text', 'role'])('accepts { %s }', (field) => {
    expect(query, 'reticle_query is not on the surface').toBeDefined();
    expect(Object.keys(query?.inputSchema ?? {})).toContain(field);
  });

  it('and still accepts the classic by/value pair', () => {
    const keys = Object.keys(query?.inputSchema ?? {});
    expect(keys).toContain('by');
    expect(keys).toContain('value');
  });
});

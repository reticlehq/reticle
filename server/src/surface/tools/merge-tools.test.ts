import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeTools, applyMerges } from './merge-tools.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { ReticleTool } from '@reticlehq/core';
import { MERGED_TOOLS, TOOLS } from './tools.js';

const deps = {} as ToolDeps;

function member(name: string, extra: Record<string, z.ZodType> = {}): ToolDef {
  return {
    name,
    description: `${name} desc`,
    inputSchema: extra,
    handler: (_d, args) => Promise.resolve({ ran: name, got: args }),
  };
}

describe('mergeTools (surface consolidation)', () => {
  const merged = mergeTools({
    name: 'reticle_baseline',
    description: 'baseline family',
    actions: {
      save: member('reticle_baseline_save', { name: z.string() }),
      list: member('reticle_baseline_list'),
      diff: member('reticle_diff', { against: z.string().optional() }),
    },
  });

  it('advertises ONE tool with an action enum covering every member', () => {
    expect(merged.name).toBe('reticle_baseline');
    const action = merged.inputSchema['action'];
    expect(action).toBeDefined();
    expect(() =>
      z.object({ action: action as z.ZodTypeAny }).parse({ action: 'save' }),
    ).not.toThrow();
    expect(() => z.object({ action: action as z.ZodTypeAny }).parse({ action: 'nope' })).toThrow();
  });

  it('routes each action to its ORIGINAL handler, unmodified', async () => {
    expect(await merged.handler(deps, { action: 'save', name: 'x' })).toEqual({
      ran: 'reticle_baseline_save',
      got: { action: 'save', name: 'x' },
    });
    expect(await merged.handler(deps, { action: 'list' })).toMatchObject({
      ran: 'reticle_baseline_list',
    });
    expect(await merged.handler(deps, { action: 'diff' })).toMatchObject({ ran: 'reticle_diff' });
  });

  it('unions member fields and makes them optional (one schema serves every action)', () => {
    // `name` is required on save but absent on list — merged it must be optional or list breaks.
    expect(merged.inputSchema['name']?.isOptional()).toBe(true);
    expect(merged.inputSchema['against']?.isOptional()).toBe(true);
  });

  it('returns a legible error (never throws) for an unknown action', async () => {
    const out = (await merged.handler(deps, { action: 'bogus' })) as {
      error?: string;
      expected?: string[];
    };
    expect(out.error).toContain('bogus');
    expect(out.expected).toEqual(['save', 'list', 'diff']);
  });
});

describe('applyMerges (assembly-point consolidation)', () => {
  const raw: ToolDef[] = [
    member('reticle_act'),
    member('reticle_baseline_save', { name: z.string() }),
    member('reticle_baseline_list'),
    member('reticle_diff'),
    member('reticle_run_record'),
  ];
  const plans = [
    {
      name: 'reticle_baseline',
      description: 'baseline family',
      members: {
        save: 'reticle_baseline_save',
        list: 'reticle_baseline_list',
        diff: 'reticle_diff',
      },
    },
  ];

  it('drops members + retired names and appends one merged tool (net surface shrink)', () => {
    const out = applyMerges(raw, plans, ['reticle_run_record']);
    const names = out.map((t) => t.name);
    expect(names).toContain('reticle_act'); // untouched
    expect(names).toContain('reticle_baseline'); // merged
    expect(names).not.toContain('reticle_baseline_save');
    expect(names).not.toContain('reticle_diff');
    expect(names).not.toContain('reticle_run_record'); // retired
    expect(out).toHaveLength(2); // 5 → 2
  });

  it('the merged tool still reaches every original handler', async () => {
    const out = applyMerges(raw, plans);
    const baseline = out.find((t) => 'reticle_baseline' === t.name);
    expect(await baseline?.handler(deps, { action: 'diff' })).toMatchObject({
      ran: 'reticle_diff',
    });
  });

  it('throws on a plan naming a member that does not exist (a typo must not silently drop capability)', () => {
    expect(() =>
      applyMerges(raw, [{ name: 'x', description: 'd', members: { a: 'reticle_nope' } }]),
    ).toThrow(/unknown member tool/);
  });
});

/**
 * A parameter of a SIBLING action is refused, not dropped (#1536).
 *
 * The SDK checks unknown keys against the union of every action's parameters, so these passed and
 * reached a handler that never reads them: `verify { action: "change", names }` replayed every
 * affected flow, and `look { action: "page", limit }` returned the whole tree.
 */
describe('a key that belongs to another action of the same tool', () => {
  const tool = (surface: readonly ToolDef[], name: string): ToolDef => {
    const found = surface.find((t) => t.name === name);
    if (found === undefined) throw new Error(`${name} is not on this surface`);
    return found;
  };
  const refusal = (call: Promise<unknown>): Promise<string> =>
    call.then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

  it('is refused on verify { action: "change" }, naming the action that takes it', async () => {
    const said = await refusal(
      tool(TOOLS, ReticleTool.VERIFY).handler(deps, {
        action: 'change',
        files: ['src/a.tsx'],
        names: ['one-flow'],
      }),
    );
    expect(said).toContain('`names`');
    expect(said).toContain('NOT applied');
    expect(said).toContain('`names` is a parameter of action "flows"');
  });

  /*
   * An agent sent `session { action: "yield", claim, summary }`. The refusal named "end" but not what
   * to do, and "end" ends the session for good, which a yield does not.
   */
  it('says how to go on: call the action that takes the keys, or call again without them', async () => {
    const said = await refusal(
      tool(TOOLS, ReticleTool.SESSION).handler(deps, {
        action: 'yield',
        claim: 'pass',
        summary: 'done',
      }),
    );
    expect(said).toContain('Call reticle_session { action: "end" } to use them');
    expect(said).toContain('or call action "yield" again without them');
  });

  it('is refused on look { action: "page" }', async () => {
    const said = await refusal(
      tool(MERGED_TOOLS, ReticleTool.LOOK).handler(deps, { action: 'page', limit: 8 }),
    );
    expect(said).toContain('`limit` is a parameter of action "find"');
  });

  it('leaves the action’s own keys and the shared sessionId alone', async () => {
    const merged = mergeTools({
      name: 'reticle_pair',
      description: 'two',
      actions: {
        one: member('a', { only: z.string().optional(), sessionId: z.string().optional() }),
        two: member('b', { other: z.string().optional() }),
      },
    });
    await expect(
      merged.handler(deps, { action: 'two', other: 'x', sessionId: 's1' }),
    ).resolves.toMatchObject({ ran: 'b' });
    await expect(merged.handler(deps, { action: 'two', only: 'x' })).rejects.toThrow(
      '`only` is a parameter of action "one"',
    );
  });
});

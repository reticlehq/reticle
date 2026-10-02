import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeTools } from './merge-tools.js';
import { mergeActWithSequence } from './act-merged.js';
import type { ToolDef } from './tool-kit.js';

/**
 * The incident: merging `reticle_act` into a family while building the 10-tool surface.
 *
 * `reticle_act` declares its own `action` parameter — the DOM action (click/fill/press). The merged
 * schema was built as `{ action: enum(members), ...unionShape(members) }`, and the union spreads
 * SECOND, so the member's `action` replaced the dispatch enum. The merged tool then advertised
 * normally, accepted `action: "click"`, looked it up as a member name, and answered
 * `unknown action 'click'` — for every call, on every action. A whole family, unroutable, with a
 * green build and a tool list that looked right.
 *
 * Caught before it shipped; the test is here because the failure mode is invisible from the outside.
 */
const tool = (name: string, shape: z.ZodRawShape): ToolDef => ({
  name,
  description: name,
  inputSchema: shape,
  handler: () => Promise.resolve({ ran: name }),
});

describe('a merged family cannot be built on a member that owns the discriminator', () => {
  it('refuses at build time when a member declares its own `action`', () => {
    expect(() =>
      mergeTools({
        name: 'reticle_act',
        description: 'act',
        actions: {
          one: tool('reticle_act_one', { action: z.string(), ref: z.string() }),
          many: tool('reticle_act_many', { steps: z.array(z.string()) }),
        },
      }),
    ).toThrow(/declares its own 'action' parameter/);
  });

  it('still merges a family whose members leave `action` alone, and dispatches on it', async () => {
    const merged = mergeTools({
      name: 'reticle_look',
      description: 'look',
      actions: {
        page: tool('reticle_snapshot', { mode: z.string().optional() }),
        find: tool('reticle_query', { by: z.string().optional() }),
      },
    });
    expect(Object.keys(merged.inputSchema)).toContain('action');
    // The mutation this kills: if the discriminator is overwritten, this answers `unknown action`.
    const deps = {} as never;
    expect(await merged.handler(deps, { action: 'find' })).toEqual({ ran: 'reticle_query' });
  });
});

/**
 * The shape-routed merge has one failure the action-dispatched ones cannot have.
 *
 * `reticle_act` routes on the presence of `steps`. A call naming `steps` AND `ref` is two different
 * requests in one object, and the obvious implementation — route on `steps` — runs the sequence and
 * silently discards the single action the caller also wrote. Nobody is told; the result looks like a
 * successful batch. Merging is what made the question askable at all, so the guard lands with it.
 */
describe('the act merge refuses a call that names both shapes', () => {
  it('refuses `steps` together with `ref` instead of picking one', async () => {
    const merged = mergeActWithSequence(
      tool('reticle_act', { ref: z.string(), action: z.string() }),
      tool('reticle_act_sequence', { steps: z.array(z.unknown()) }),
    );
    const deps = {} as never;
    const both = (await merged.handler(deps, { ref: 'e1', action: 'click', steps: [] })) as {
      error?: string;
    };
    expect(both.error).toMatch(/ambiguous/);
    // And neither shape alone is affected — the refusal must not cost the two real calls.
    expect(await merged.handler(deps, { steps: [] })).toEqual({ ran: 'reticle_act_sequence' });
    expect(await merged.handler(deps, { ref: 'e1', action: 'click' })).toEqual({
      ran: 'reticle_act',
    });
  });
});

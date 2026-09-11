/**
 * The predicate grammar has to be reachable from the surface that promises it.
 *
 * A lean tool schema advertises the kind list and then says "call reticle_tools for the full field
 * grammar of a kind" — and `reticle_tools` answered with the parameter prose, which for
 * `reticle_act_and_wait { until }` is "same shape as reticle_assert". So the one pointer the surface
 * offers led to another pointer, and an agent that could not find the fields fell back to a `text`
 * check where a route/net/signal check was meant. A weaker oracle is the expensive half of this
 * defect; the wasted round trips are the cheap half.
 *
 * The grammar rides on the `names:[…]` reply only, so nothing is added to the per-turn tool listing.
 *
 * `reticle_tools` also had to start refusing an unknown argument. It declared one parameter and
 * checked none: a call naming the wrong one had the key dropped and came back with the FULL
 * catalogue — a well-formed answer to a question nobody asked, and indistinguishable from one.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PredicateSchema } from '../events/predicate-eval.js';
import { buildDynamicTools } from './dynamic-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tools.js';

const NO_DEPS = {} as ToolDeps;

const fakeTools: ToolDef[] = [
  {
    name: 'reticle_asserty',
    description: 'Assert a predicate.',
    inputSchema: { until: PredicateSchema.optional().describe('Same shape as reticle_assert.') },
    handler: () => Promise.resolve({ ok: true }),
  },
  {
    name: 'reticle_plain',
    description: 'Take no predicate at all.',
    inputSchema: { ref: z.string() },
    handler: () => Promise.resolve({ ok: true }),
  },
];

const discover = (): ToolDef => {
  const found = buildDynamicTools(fakeTools).find((tool) => tool.name === ReticleTool.TOOLS);
  if (undefined === found) throw new Error('reticle_tools must exist');
  return found;
};

interface GrammarReply {
  tools?: unknown;
  total?: number;
  error?: string;
  hint?: string;
  predicateGrammar?: Record<string, string>;
}

describe('reticle_tools carries the predicate grammar for a tool that takes one', () => {
  it('returns the fields of every kind, not another pointer', async () => {
    const reply = (await discover().handler(NO_DEPS, {
      names: ['reticle_asserty'],
    })) as GrammarReply;
    const grammar = reply.predicateGrammar ?? {};
    // The kinds an agent has to guess fields for, and the field each rejection named in the field.
    expect(grammar['route']).toContain('pathname');
    expect(grammar['net']).toContain('bodyContains');
    expect(grammar['not']).toContain('predicate');
    expect(grammar['state']).toContain('path');
    // `element` is the one kind whose shape a flat field list cannot convey.
    expect(grammar['element']).toContain('query');
    expect(grammar['element']).toContain('role');
  });

  it('says nothing about predicates for a tool that does not take one', async () => {
    const reply = (await discover().handler(NO_DEPS, { names: ['reticle_plain'] })) as GrammarReply;
    expect(reply.predicateGrammar).toBeUndefined();
  });

  it('keeps the catalog listing free of it, so no turn pays for the grammar unasked', async () => {
    const reply = (await discover().handler(NO_DEPS, {})) as GrammarReply;
    expect(reply.total).toBe(fakeTools.length);
    expect(reply.predicateGrammar).toBeUndefined();
  });
});

describe('reticle_tools refuses an unknown argument', () => {
  it('does not answer the catalogue question nobody asked', async () => {
    const reply = (await discover().handler(NO_DEPS, { tool: 'reticle_asserty' })) as GrammarReply;
    expect(reply.error).toContain('tool');
    expect(reply.error).toMatch(/NOT applied/i);
    expect(reply.tools).toBeUndefined();
  });

  it('names the argument the caller probably meant', async () => {
    const reply = (await discover().handler(NO_DEPS, { tool: 'reticle_asserty' })) as GrammarReply;
    expect(`${reply.hint}`).toContain('names');
  });
});

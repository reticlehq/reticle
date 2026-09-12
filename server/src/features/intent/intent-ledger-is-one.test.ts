import { describe, it, expect } from 'vitest';
import { INTENT_TOOLS } from './intent-tools.js';
import { createMemoryFs } from '../project/memory-fs.js';
import type { ToolDeps } from '../../agent/tools/tools.js';

/**
 * One logical ledger, however many files it is kept in.
 *
 * `reticle_intent` writes through TWO stores. `declare`/`bind`/`list` use the flat
 * `.reticle/intent.json`; `record`/`get`/`index`/`subject` use the sharded `.reticle/intent/`
 * directory, and `migrate` moves one into the other by hand. They are not two views of one thing —
 * they are separate files, so an intent written through one action was invisible to the other.
 *
 * That matters more here than almost anywhere else in the product. An intent ledger is the record of
 * what was CLAIMED and whether it was ever proved; a claim that silently cannot be found again is
 * the false-green shape this release opened by fixing. An agent that records an intent and then
 * cannot list it does not conclude "two stores" — it concludes the intent does not exist.
 *
 * The tool is the right place to reconcile: it is the one seam that knows both stores exist, and
 * neither store should have to learn the other's layout to stay honest.
 */
const tool = INTENT_TOOLS.find((t) => t.name.includes('intent'));

function depsIn(root: string): ToolDeps {
  const { fs } = createMemoryFs();
  return {
    fs,
    reticleRoot: root,
    now: () => 1,
    sessions: {
      resolve: () => ({ id: 's1', url: 'http://app.test/', projectId: undefined }),
    },
  } as unknown as ToolDeps;
}

describe('the intent ledger is ONE ledger', () => {
  it('an intent written by `record` is findable by `list`', async () => {
    const deps = depsIn('/repo/.reticle');

    await tool?.handler(deps, {
      action: 'record',
      id: 'i-1',
      statement: 'applying a discount reduces the total',
      subject: 'checkout',
    });

    const listed = (await tool?.handler(deps, { action: 'list' })) as { intents?: unknown[] };
    const ids = (listed.intents ?? []).map((i) => (i as { id?: string }).id);
    expect(ids, 'recorded through one action, invisible to the other').toContain('i-1');
  });

  it('an intent written by `declare` is findable by `get`', async () => {
    const deps = depsIn('/repo/.reticle');

    await tool?.handler(deps, {
      action: 'declare',
      intents: [{ id: 'i-2', statement: 'the receipt appears after paying' }],
    });

    const got = (await tool?.handler(deps, { action: 'get', id: 'i-2' })) as {
      record?: { id?: string } | null;
    };
    expect(got.record?.id, 'declared through one action, invisible to the other').toBe('i-2');
  });
});

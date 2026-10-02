/**
 * A step label is refused on every route into the ledger, and the refusal is SAID where a caller can
 * act on it.
 *
 * The explicit tool answers `refused` with the reason, because an agent that declared something and
 * finds nothing stored would otherwise conclude the store lost it. The inline route returns no id, so
 * a verdict never believes it is linked to an intent that was never written.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { INTENT_TOOLS } from './intent-tools.js';
import { linkInlineIntent } from './inline-intent.js';

const ROOT = '/repo/.reticle';

function deps(): ToolDeps {
  const { fs } = createMemoryFs();
  return {
    fs,
    reticleRoot: ROOT,
    now: () => 1,
    sessions: {
      resolve: () => {
        throw new Error('no session');
      },
      count: () => 0,
    },
  } as unknown as ToolDeps;
}

const intentTool = INTENT_TOOLS[0];

describe('step labels never become intents', () => {
  it('the tool refuses one and says why, and still declares the real one beside it', async () => {
    const out = (await intentTool?.handler(deps(), {
      action: 'declare',
      intents: [
        { id: 'label', statement: 'click button "Cancel"' },
        { id: 'rule', statement: 'cancelling an order refunds it in full' },
      ],
    })) as { intents: { id: string }[]; refused?: { id: string; reason: string }[] };
    expect(out.intents.map((i) => i.id)).toEqual(['rule']);
    expect(out.refused?.map((r) => r.id)).toEqual(['label']);
    expect(out.refused?.[0]?.reason).toContain('what must be true');
  });

  it('an inline label links to nothing, so no verdict claims to have proved it', async () => {
    const d = deps();
    expect(
      await linkInlineIntent(d, undefined, 'click link "Settlements"', { kind: 'net' }),
    ).toBeUndefined();
    expect(
      await linkInlineIntent(d, undefined, 'a refund sends the captured amount', { kind: 'net' }),
    ).toBeDefined();
  });
});

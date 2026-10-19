/**
 * The page's structure at each step, with no text in it: what an export can carry.
 *
 * The episode keeps each snapshot whole, on the machine. A dataset needs the shape of the page
 * (roles, nesting, form state) without the words on it, which are somebody else's data.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { exportStructure, structureOfTree } from './episode-structure.js';

const TREE = [
  '- main',
  '  - heading "Checkout for alice@example.com" (ref=e1)',
  '  - textbox "Promo code" (ref=e2) [value="SECRET-PROMO"] [focused]',
  '  - checkbox "Keep me signed in" (ref=e3) [checked]',
  '  - list [grid-cols:1fr 1fr]',
  '    - text "Total $80"',
  '    - button "Place order" (ref=e4) [disabled]',
  '  - generic [text="Shipping to 10 Downing St"]',
].join('\n');

describe('the structure of a snapshot', () => {
  it('keeps roles, depth, refs, layout and state, and no text at all', () => {
    const nodes = structureOfTree(TREE);
    expect(nodes).toEqual([
      { depth: 0, role: 'main' },
      { depth: 1, role: 'heading', ref: 'e1', named: true },
      { depth: 1, role: 'textbox', ref: 'e2', named: true, valued: true, states: ['focused'] },
      { depth: 1, role: 'checkbox', ref: 'e3', named: true, states: ['checked'] },
      { depth: 1, role: 'list', layout: 'grid-cols:1fr 1fr' },
      { depth: 2, role: 'text', texted: true },
      { depth: 2, role: 'button', ref: 'e4', named: true, states: ['disabled'] },
      { depth: 1, role: 'generic', texted: true },
    ]);
    const out = JSON.stringify(nodes);
    for (const word of ['alice', 'Promo', 'SECRET', 'Keep', 'Total', 'Place', 'Downing'])
      expect(out).not.toContain(word);
  });

  it('never copies a word it cannot place', () => {
    // A name holding what looks like a ref, a state and a layout is still only a name.
    const nodes = structureOfTree(
      '- button "Weird (ref=e9) [checked] [grid]" (ref=e5)\n- Not a role\nnot a line',
    );
    expect(nodes).toEqual([{ depth: 0, role: 'button', ref: 'e5', named: true }]);
  });
});

describe('the structure export', () => {
  it('turns every snapshot in the episodes into one structure line, and skips cut results', () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'structure-')));
    const episodes = join(project, ReticleDir.ROOT, ReticleDir.EPISODES_SUBDIR);
    mkdirSync(episodes, { recursive: true });
    const lines = [
      { kind: 'start', episodeId: 'conn-1', at: 1 },
      {
        kind: 'call',
        n: 1,
        tool: 'reticle_snapshot',
        sessionId: 's1',
        startedAt: 5,
        result: { tree: TREE },
      },
      { kind: 'call', n: 2, tool: 'reticle_act', startedAt: 6, result: { ok: true } },
      {
        kind: 'call',
        n: 3,
        tool: 'reticle_snapshot',
        startedAt: 7,
        result: { head: '{"tree":"- ma' },
        truncated: ['result'],
      },
    ];
    writeFileSync(join(episodes, 'conn-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const out: string[] = [];
    const summary = exportStructure(join(project, ReticleDir.ROOT), (line) => out.push(line));
    expect(summary).toEqual({ steps: 1, skippedCut: 1 });
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      episodeId: 'conn-1',
      n: 1,
      tool: 'reticle_snapshot',
      sessionId: 's1',
      startedAt: 5,
      structure: structureOfTree(TREE),
    });
    expect(out.join('\n')).not.toContain('Promo');
  });
});
